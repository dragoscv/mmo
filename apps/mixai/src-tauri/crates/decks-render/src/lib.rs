//! MixAI Decks GPU views, drawn once in Rust with wgpu (ADR-0014 D61).
//!
//! One [`Renderer`] draws a set of views ([`ViewSpec`]) into either a native surface — a
//! `CAMetalLayer` (SwiftUI), an `ANativeWindow` (Compose Android `SurfaceView`) or a window handle
//! (Compose Desktop HWND / X11 / Wayland) — or an offscreen texture ([`Renderer::new_headless`])
//! for snapshots and for hosts that composite textures themselves.
//!
//! Frame loop: [`Renderer::update`] with a borrowed [`FrameState`] (playheads, grids, zoom,
//! markers), then [`Renderer::render`]. Peaks change rarely and are uploaded with
//! [`Renderer::set_peaks`]. Text labels are not drawn here: the native UI overlays them.
//!
//! Views: scrolling three-band waveform (centred playhead, zoom, beat grid with downbeats,
//! cue / hot cue / loop markers, slip shadow playhead), whole-track overview (played region
//! dimmed, hot cues), stacked 2–4 deck waveforms with phase meters, rotating platter with a
//! procedural vinyl shader, DVS X/Y scope. Styles RGB / single colour / spectral, light and
//! dark theme, reduced motion (page-flip waveform, 30° platter steps).
//!
//! Building a frame allocates nothing in this crate: instance data goes into arrays sized once
//! at construction (unit test `alloc_tests`), the GPU does the per-pixel peak lookup from one
//! storage buffer, and every view is drawn by two pipelines of instanced quads. (wgpu's own
//! `write_buffer` staging and command encoders are wgpu's business.)

#![warn(missing_docs)]

#[cfg(test)]
mod alloc_tests;
pub mod colors;
pub mod demo;
mod model;
mod scene;

use std::fmt;

use raw_window_handle::{
    DisplayHandle, HandleError, HasDisplayHandle, RawDisplayHandle, RawWindowHandle,
};

pub use colors::{DECK_COLORS, Palette, Rgba, Theme};
pub use model::{
    BandPeaks, BeatGrid, DeckFrame, FrameState, Marker, MarkerKind, PeaksView, Rect, ViewKind,
    ViewSpec, WaveStyle,
};
use scene::{MAX_SHAPES, MAX_VIEWS, MAX_WAVES, PeaksSlot, Scene, Shape, WaveGpu};

/// Errors from renderer construction and rendering.
#[derive(Debug)]
pub enum RenderError {
    /// No GPU adapter, not even a software fallback.
    NoAdapter(String),
    /// The device request failed.
    Device(String),
    /// The surface could not be created or is not supported by the adapter.
    Surface(String),
    /// Width or height is zero.
    ZeroSize,
}

impl fmt::Display for RenderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoAdapter(e) => write!(f, "no GPU adapter: {e}"),
            Self::Device(e) => write!(f, "GPU device request failed: {e}"),
            Self::Surface(e) => write!(f, "surface error: {e}"),
            Self::ZeroSize => write!(f, "surface size is zero"),
        }
    }
}

impl std::error::Error for RenderError {}

/// Display handle captured from the host (needed by GLES / Wayland, unused by Vulkan/Metal/DX12).
#[derive(Debug)]
struct HostDisplay(RawDisplayHandle);

// SAFETY: the host guarantees (contract of `new_from_raw_handle`) that the display connection
// outlives the renderer; wgpu only reads the handle when creating surfaces.
unsafe impl Send for HostDisplay {}
// SAFETY: see `Send` above; the handle is immutable.
unsafe impl Sync for HostDisplay {}

impl HasDisplayHandle for HostDisplay {
    fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
        // SAFETY: validity for the renderer's lifetime is the caller's contract.
        Ok(unsafe { DisplayHandle::borrow_raw(self.0) })
    }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Globals {
    viewport: [f32; 2],
    srgb_target: f32,
    dark: f32,
    background: [f32; 4],
    low: [f32; 4],
    mid: [f32; 4],
    high: [f32; 4],
}

enum Target {
    Surface {
        surface: wgpu::Surface<'static>,
        config: wgpu::SurfaceConfiguration,
    },
    Headless {
        texture: wgpu::Texture,
        view: wgpu::TextureView,
    },
}

/// Peaks of one deck, packed for the GPU (one u32 per band per point).
#[derive(Default)]
struct DeckPeaks {
    packed: Vec<u32>,
    pps: f32,
}

const HEADLESS_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
/// Initial peaks capacity per deck in points (10 min at 150 pts/s); grows on demand.
const INITIAL_POINTS_PER_DECK: usize = 90_000;

/// GPU renderer for the deck views. See the crate docs.
pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    adapter_info: wgpu::AdapterInfo,
    target: Target,
    format: wgpu::TextureFormat,
    size: (u32, u32),
    scale: f32,
    shape_pipeline: wgpu::RenderPipeline,
    wave_pipeline: wgpu::RenderPipeline,
    bind_layout: wgpu::BindGroupLayout,
    bind_group: wgpu::BindGroup,
    globals_buf: wgpu::Buffer,
    peaks_buf: wgpu::Buffer,
    shape_buf: wgpu::Buffer,
    wave_buf: wgpu::Buffer,
    points_per_deck: usize,
    decks: [DeckPeaks; 4],
    views: Vec<ViewSpec>,
    scene: Scene,
    n_under: u32,
    n_over: u32,
    n_waves: u32,
    clear: wgpu::Color,
    readback: Option<wgpu::Buffer>,
}

fn srgb_to_linear(c: f32) -> f64 {
    let c = f64::from(c);
    if c <= 0.040_45 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn instance(backends: wgpu::Backends) -> wgpu::Instance {
    let mut d = wgpu::InstanceDescriptor::new_without_display_handle_from_env();
    d.backends = backends;
    wgpu::Instance::new(d)
}

fn adapter_options<'a>(
    surface: Option<&'a wgpu::Surface<'a>>,
    fallback: bool,
) -> wgpu::RequestAdapterOptions<'a, 'a> {
    wgpu::RequestAdapterOptions {
        power_preference: if fallback {
            wgpu::PowerPreference::LowPower
        } else {
            wgpu::PowerPreference::HighPerformance
        },
        force_fallback_adapter: fallback,
        compatible_surface: surface,
        apply_limit_buckets: false,
    }
}

impl Renderer {
    /// Renderer drawing into a native window / layer.
    ///
    /// `size` is in physical pixels, `scale` is physical pixels per logical pixel (view rects
    /// are logical). Raw handles: `AppKit`/`UiKit` (a view whose layer is a `CAMetalLayer`),
    /// `AndroidNdk` (`ANativeWindow` from a `SurfaceView`), `Win32` (HWND), `Xlib`/`Xcb`,
    /// `Wayland`.
    ///
    /// # Safety
    ///
    /// `window` and `display` must stay valid until the renderer is dropped (on Android: drop it
    /// in `surfaceDestroyed`).
    pub unsafe fn new_from_raw_handle(
        window: RawWindowHandle,
        display: RawDisplayHandle,
        size: (u32, u32),
        scale: f32,
    ) -> Result<Self, RenderError> {
        if size.0 == 0 || size.1 == 0 {
            return Err(RenderError::ZeroSize);
        }
        pollster::block_on(async {
            let desc = wgpu::InstanceDescriptor::new_with_display_handle_from_env(Box::new(
                HostDisplay(display),
            ));
            let instance = wgpu::Instance::new(desc);
            // SAFETY: handle validity is this function's contract.
            let surface = unsafe {
                instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
                    raw_display_handle: Some(display),
                    raw_window_handle: window,
                })
            }
            .map_err(|e| RenderError::Surface(e.to_string()))?;
            let adapter = instance
                .request_adapter(&adapter_options(Some(&surface), false))
                .await
                .map_err(|e| RenderError::NoAdapter(e.to_string()))?;
            Self::with_surface(adapter, surface, size, scale).await
        })
    }

    /// Renderer drawing into a window that owns its handles (e.g. `Arc<winit::window::Window>`).
    pub fn new_from_window(
        window: impl Into<wgpu::SurfaceTarget<'static>>,
        size: (u32, u32),
        scale: f32,
    ) -> Result<Self, RenderError> {
        if size.0 == 0 || size.1 == 0 {
            return Err(RenderError::ZeroSize);
        }
        pollster::block_on(async {
            let instance = instance(wgpu::Backends::all().with_env());
            let surface = instance
                .create_surface(window)
                .map_err(|e| RenderError::Surface(e.to_string()))?;
            let adapter = instance
                .request_adapter(&adapter_options(Some(&surface), false))
                .await
                .map_err(|e| RenderError::NoAdapter(e.to_string()))?;
            Self::with_surface(adapter, surface, size, scale).await
        })
    }

    async fn with_surface(
        adapter: wgpu::Adapter,
        surface: wgpu::Surface<'static>,
        size: (u32, u32),
        scale: f32,
    ) -> Result<Self, RenderError> {
        let caps = surface.get_capabilities(&adapter);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| !f.is_srgb())
            .or_else(|| caps.formats.first().copied())
            .ok_or_else(|| RenderError::Surface("adapter cannot present to this surface".into()))?;
        let alpha_mode = if caps.alpha_modes.contains(&wgpu::CompositeAlphaMode::Opaque) {
            wgpu::CompositeAlphaMode::Opaque
        } else {
            caps.alpha_modes
                .first()
                .copied()
                .unwrap_or(wgpu::CompositeAlphaMode::Auto)
        };
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            color_space: wgpu::SurfaceColorSpace::Auto,
            width: size.0,
            height: size.1,
            desired_maximum_frame_latency: 1,
            // Fifo = vsync at the display rate (120 Hz on ProMotion / high-refresh panels).
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode,
            view_formats: vec![],
        };
        let (device, queue) = Self::request_device(&adapter).await?;
        surface.configure(&device, &config);
        let info = adapter.get_info();
        Ok(Self::build(
            device,
            queue,
            info,
            Target::Surface { surface, config },
            format,
            size,
            scale,
        ))
    }

    /// Offscreen renderer drawing into an `Rgba8Unorm` texture of `size` physical pixels
    /// (scale 1). Uses the default backends; if none yields an adapter, retries all backends with
    /// a forced software fallback adapter.
    pub fn new_headless(size: (u32, u32)) -> Result<Self, RenderError> {
        if size.0 == 0 || size.1 == 0 {
            return Err(RenderError::ZeroSize);
        }
        pollster::block_on(async {
            let primary = instance(wgpu::Backends::default().with_env());
            let adapter = match primary.request_adapter(&adapter_options(None, false)).await {
                Ok(a) => a,
                Err(e1) => instance(wgpu::Backends::all())
                    .request_adapter(&adapter_options(None, true))
                    .await
                    .map_err(|e2| RenderError::NoAdapter(format!("{e1}; fallback: {e2}")))?,
            };
            let (device, queue) = Self::request_device(&adapter).await?;
            let (texture, view) = Self::make_headless_texture(&device, size);
            let info = adapter.get_info();
            Ok(Self::build(
                device,
                queue,
                info,
                Target::Headless { texture, view },
                HEADLESS_FORMAT,
                size,
                1.0,
            ))
        })
    }

    async fn request_device(
        adapter: &wgpu::Adapter,
    ) -> Result<(wgpu::Device, wgpu::Queue), RenderError> {
        adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("decks-render"),
                required_limits: wgpu::Limits::downlevel_defaults()
                    .using_resolution(adapter.limits()),
                ..Default::default()
            })
            .await
            .map_err(|e| RenderError::Device(e.to_string()))
    }

    fn make_headless_texture(
        device: &wgpu::Device,
        size: (u32, u32),
    ) -> (wgpu::Texture, wgpu::TextureView) {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("decks-render headless"),
            size: wgpu::Extent3d {
                width: size.0,
                height: size.1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: HEADLESS_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        (texture, view)
    }

    fn peaks_buffer(device: &wgpu::Device, points_per_deck: usize) -> wgpu::Buffer {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("decks-render peaks"),
            size: (points_per_deck * 4 * 3 * 4) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }

    fn make_bind_group(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        globals: &wgpu::Buffer,
        peaks: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("decks-render bind group"),
            layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: globals.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: peaks.as_entire_binding(),
                },
            ],
        })
    }

    fn build(
        device: wgpu::Device,
        queue: wgpu::Queue,
        adapter_info: wgpu::AdapterInfo,
        target: Target,
        format: wgpu::TextureFormat,
        size: (u32, u32),
        scale: f32,
    ) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("decks-render shaders"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders.wgsl").into()),
        });
        let buffer_entry = |binding, visibility, ty| wgpu::BindGroupLayoutEntry {
            binding,
            visibility,
            ty: wgpu::BindingType::Buffer {
                ty,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("decks-render layout"),
            entries: &[
                buffer_entry(
                    0,
                    wgpu::ShaderStages::VERTEX_FRAGMENT,
                    wgpu::BufferBindingType::Uniform,
                ),
                buffer_entry(
                    1,
                    wgpu::ShaderStages::FRAGMENT,
                    wgpu::BufferBindingType::Storage { read_only: true },
                ),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("decks-render pipeline layout"),
            bind_group_layouts: &[Some(&bind_layout)],
            immediate_size: 0,
        });
        let target_state = [Some(wgpu::ColorTargetState {
            format,
            blend: Some(wgpu::BlendState::ALPHA_BLENDING),
            write_mask: wgpu::ColorWrites::ALL,
        })];
        let shape_attrs = wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32x4, 2 => Float32x4];
        let wave_attrs = wgpu::vertex_attr_array![
            0 => Float32x4, 1 => Float32x4, 2 => Uint32x4, 3 => Float32x4
        ];
        let pipeline =
            |label: &str, vs: &str, fs: &str, stride: usize, attrs: &[wgpu::VertexAttribute]| {
                device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some(label),
                    layout: Some(&pipeline_layout),
                    vertex: wgpu::VertexState {
                        module: &shader,
                        entry_point: Some(vs),
                        compilation_options: Default::default(),
                        buffers: &[Some(wgpu::VertexBufferLayout {
                            array_stride: stride as u64,
                            step_mode: wgpu::VertexStepMode::Instance,
                            attributes: attrs,
                        })],
                    },
                    primitive: wgpu::PrimitiveState::default(),
                    depth_stencil: None,
                    multisample: wgpu::MultisampleState::default(),
                    fragment: Some(wgpu::FragmentState {
                        module: &shader,
                        entry_point: Some(fs),
                        compilation_options: Default::default(),
                        targets: &target_state,
                    }),
                    multiview_mask: None,
                    cache: None,
                })
            };
        let shape_pipeline = pipeline(
            "decks-render shapes",
            "vs_shape",
            "fs_shape",
            size_of::<Shape>(),
            &shape_attrs,
        );
        let wave_pipeline = pipeline(
            "decks-render waves",
            "vs_wave",
            "fs_wave",
            size_of::<WaveGpu>(),
            &wave_attrs,
        );
        let globals_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("decks-render globals"),
            size: size_of::<Globals>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let peaks_buf = Self::peaks_buffer(&device, INITIAL_POINTS_PER_DECK);
        let bind_group = Self::make_bind_group(&device, &bind_layout, &globals_buf, &peaks_buf);
        let vertex_buffer = |label, bytes: usize| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: bytes as u64,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        let shape_buf = vertex_buffer("decks-render shapes", MAX_SHAPES * size_of::<Shape>());
        let wave_buf = vertex_buffer("decks-render waves", MAX_WAVES * size_of::<WaveGpu>());
        Self {
            device,
            queue,
            adapter_info,
            target,
            format,
            size,
            scale,
            shape_pipeline,
            wave_pipeline,
            bind_layout,
            bind_group,
            globals_buf,
            peaks_buf,
            shape_buf,
            wave_buf,
            points_per_deck: INITIAL_POINTS_PER_DECK,
            decks: Default::default(),
            views: Vec::with_capacity(MAX_VIEWS),
            scene: Scene::new(),
            n_under: 0,
            n_over: 0,
            n_waves: 0,
            clear: wgpu::Color::BLACK,
            readback: None,
        }
    }

    /// Name and backend of the GPU adapter in use (e.g. for logs).
    pub fn adapter_info(&self) -> &wgpu::AdapterInfo {
        &self.adapter_info
    }

    /// Surface / texture size in physical pixels.
    pub fn size(&self) -> (u32, u32) {
        self.size
    }

    /// The wgpu device (for hosts that share it, e.g. to composite the headless texture).
    pub fn device(&self) -> &wgpu::Device {
        &self.device
    }

    /// The offscreen target texture (`None` for surface renderers).
    pub fn headless_texture(&self) -> Option<&wgpu::Texture> {
        match &self.target {
            Target::Headless { texture, .. } => Some(texture),
            Target::Surface { .. } => None,
        }
    }

    /// Resizes the target (physical pixels) and updates the logical→physical scale.
    pub fn resize(&mut self, size: (u32, u32), scale: f32) {
        if size.0 == 0 || size.1 == 0 {
            return;
        }
        self.size = size;
        self.scale = scale;
        self.readback = None;
        match &mut self.target {
            Target::Surface { surface, config } => {
                config.width = size.0;
                config.height = size.1;
                surface.configure(&self.device, config);
            }
            Target::Headless { texture, view } => {
                (*texture, *view) = Self::make_headless_texture(&self.device, size);
            }
        }
    }

    /// Replaces the view layout (at most 32 views; extra views are ignored).
    pub fn set_views(&mut self, views: &[ViewSpec]) {
        self.views.clear();
        self.views.extend(views.iter().take(MAX_VIEWS).copied());
    }

    /// Uploads the peaks of `deck` (0..4). Call on track load, not per frame.
    pub fn set_peaks(&mut self, deck: usize, peaks: &PeaksView<'_>) {
        let Some(d) = self.decks.get_mut(deck) else {
            return;
        };
        let n = peaks.len();
        d.pps = peaks.points_per_second;
        d.packed.clear();
        d.packed.reserve(n * 3);
        let pack = |b: &BandPeaks<'_>, i: usize| {
            u32::from(b.min[i]) | (u32::from(b.max[i]) << 8) | (u32::from(b.rms[i]) << 16)
        };
        for i in 0..n {
            d.packed.push(pack(&peaks.low, i));
            d.packed.push(pack(&peaks.mid, i));
            d.packed.push(pack(&peaks.high, i));
        }
        if n > self.points_per_deck {
            self.points_per_deck = n.next_power_of_two();
            self.peaks_buf = Self::peaks_buffer(&self.device, self.points_per_deck);
            self.bind_group = Self::make_bind_group(
                &self.device,
                &self.bind_layout,
                &self.globals_buf,
                &self.peaks_buf,
            );
            for i in 0..4 {
                self.upload_deck(i);
            }
        } else {
            self.upload_deck(deck);
        }
    }

    fn upload_deck(&self, deck: usize) {
        let d = &self.decks[deck];
        if d.packed.is_empty() {
            return;
        }
        let offset = (deck * self.points_per_deck * 3 * 4) as u64;
        self.queue
            .write_buffer(&self.peaks_buf, offset, bytemuck::cast_slice(&d.packed));
    }

    /// Prepares the next frame from `state`. Allocates nothing on the CPU side.
    pub fn update(&mut self, state: &FrameState<'_>) {
        let mut slots = [PeaksSlot::default(); 4];
        for (i, s) in slots.iter_mut().enumerate() {
            *s = PeaksSlot {
                offset: (i * self.points_per_deck) as u32,
                count: (self.decks[i].packed.len() / 3) as u32,
                pps: self.decks[i].pps,
            };
        }
        self.scene.build(&self.views, state, &slots, self.scale);
        let p = self.scene.palette;
        let srgb = self.format.is_srgb();
        let bg = p.background;
        self.clear = if srgb {
            wgpu::Color {
                r: srgb_to_linear(bg[0]),
                g: srgb_to_linear(bg[1]),
                b: srgb_to_linear(bg[2]),
                a: 1.0,
            }
        } else {
            wgpu::Color {
                r: f64::from(bg[0]),
                g: f64::from(bg[1]),
                b: f64::from(bg[2]),
                a: 1.0,
            }
        };
        let globals = Globals {
            viewport: [self.size.0 as f32, self.size.1 as f32],
            srgb_target: if srgb { 1.0 } else { 0.0 },
            dark: if state.theme == Theme::Dark { 1.0 } else { 0.0 },
            background: bg,
            low: p.low,
            mid: p.mid,
            high: p.high,
        };
        self.queue
            .write_buffer(&self.globals_buf, 0, bytemuck::bytes_of(&globals));
        let under = &self.scene.under;
        let over = &self.scene.over;
        if !under.is_empty() {
            self.queue
                .write_buffer(&self.shape_buf, 0, bytemuck::cast_slice(under));
        }
        if !over.is_empty() {
            let off = (under.len() * size_of::<Shape>()) as u64;
            self.queue
                .write_buffer(&self.shape_buf, off, bytemuck::cast_slice(over));
        }
        if !self.scene.waves.is_empty() {
            self.queue
                .write_buffer(&self.wave_buf, 0, bytemuck::cast_slice(&self.scene.waves));
        }
        self.n_under = under.len() as u32;
        self.n_over = over.len() as u32;
        self.n_waves = self.scene.waves.len() as u32;
    }

    /// Shapes dropped in the last [`update`](Self::update) because the fixed budget was full.
    pub fn dropped_shapes(&self) -> usize {
        self.scene.dropped
    }

    fn encode(&self, view: &wgpu::TextureView) -> wgpu::CommandEncoder {
        let mut enc = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("decks-render"),
            });
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("decks-render pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(self.clear),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_bind_group(0, &self.bind_group, &[]);
            pass.set_pipeline(&self.shape_pipeline);
            pass.set_vertex_buffer(0, self.shape_buf.slice(..));
            if self.n_under > 0 {
                pass.draw(0..6, 0..self.n_under);
            }
            if self.n_waves > 0 {
                pass.set_pipeline(&self.wave_pipeline);
                pass.set_vertex_buffer(0, self.wave_buf.slice(..));
                pass.draw(0..6, 0..self.n_waves);
                pass.set_pipeline(&self.shape_pipeline);
                pass.set_vertex_buffer(0, self.shape_buf.slice(..));
            }
            if self.n_over > 0 {
                pass.draw(0..6, self.n_under..self.n_under + self.n_over);
            }
        }
        enc
    }

    /// Draws the frame prepared by [`update`](Self::update) and presents it (surface) or leaves
    /// it in the offscreen texture (headless). A timed-out, occluded or outdated surface skips
    /// the frame (reconfiguring when needed).
    pub fn render(&mut self) -> Result<(), RenderError> {
        match &self.target {
            Target::Headless { view, .. } => {
                let enc = self.encode(view);
                self.queue.submit([enc.finish()]);
                Ok(())
            }
            Target::Surface { surface, config } => match surface.get_current_texture() {
                wgpu::CurrentSurfaceTexture::Success(frame)
                | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => {
                    let view = frame
                        .texture
                        .create_view(&wgpu::TextureViewDescriptor::default());
                    let enc = self.encode(&view);
                    self.queue.submit([enc.finish()]);
                    self.queue.present(frame);
                    Ok(())
                }
                wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                    Ok(())
                }
                wgpu::CurrentSurfaceTexture::Outdated => {
                    surface.configure(&self.device, config);
                    Ok(())
                }
                wgpu::CurrentSurfaceTexture::Lost => {
                    Err(RenderError::Surface("surface lost".into()))
                }
                wgpu::CurrentSurfaceTexture::Validation => Err(RenderError::Surface(
                    "validation error acquiring the frame".into(),
                )),
            },
        }
    }

    /// Blocks until the GPU finished all submitted work (for benchmarks and readback).
    pub fn wait_idle(&self) {
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
    }

    /// Reads the headless texture back as tightly packed RGBA8 rows (`None` for surfaces).
    /// Allocates; meant for tests and snapshots, not the frame loop.
    pub fn read_pixels(&mut self) -> Option<Vec<u8>> {
        let Target::Headless { texture, .. } = &self.target else {
            return None;
        };
        let (w, h) = self.size;
        let row = w * 4;
        let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let padded = row.div_ceil(align) * align;
        let device = &self.device;
        let buf = self.readback.get_or_insert_with(|| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("decks-render readback"),
                size: u64::from(padded) * u64::from(h),
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            })
        });
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("decks-render readback"),
        });
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: buf,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded),
                    rows_per_image: Some(h),
                },
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit([enc.finish()]);
        buf.map_async(wgpu::MapMode::Read, .., |_| {});
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        let mut out = Vec::with_capacity((row * h) as usize);
        {
            let data = buf.get_mapped_range(..).ok()?;
            for y in 0..h as usize {
                let s = y * padded as usize;
                out.extend_from_slice(&data[s..s + row as usize]);
            }
        }
        buf.unmap();
        Some(out)
    }
}
