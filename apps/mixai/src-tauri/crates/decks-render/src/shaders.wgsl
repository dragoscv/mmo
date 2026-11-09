// MixAI Decks GPU views (ADR-0014 D61). Two pipelines share one bind group:
//   vs_shape/fs_shape — instanced quads: solid rects, platter (procedural vinyl), scope dots.
//   vs_wave/fs_wave   — one quad per waveform rect; the fragment shader reads the peaks storage
//                       buffer and decides per pixel which band covers it.
// Coordinates are physical pixels, origin top-left.

struct Globals {
    viewport: vec2<f32>,
    srgb_target: f32,
    dark: f32,
    background: vec4<f32>,
    low: vec4<f32>,
    mid: vec4<f32>,
    high: vec4<f32>,
};

@group(0) @binding(0) var<uniform> g: Globals;
// One u32 per band per point: min | max << 8 | rms << 16. Three words per point (low, mid, high).
@group(0) @binding(1) var<storage, read> peaks: array<u32>;

fn corner(vi: u32) -> vec2<f32> {
    // Two triangles: (0,0) (1,0) (0,1) / (0,1) (1,0) (1,1).
    var xs = array<f32, 6>(0.0, 1.0, 0.0, 0.0, 1.0, 1.0);
    var ys = array<f32, 6>(0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
    return vec2<f32>(xs[vi], ys[vi]);
}

fn to_clip(px: vec2<f32>) -> vec4<f32> {
    let n = px / g.viewport * 2.0 - 1.0;
    return vec4<f32>(n.x, -n.y, 0.0, 1.0);
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let lo = c / 12.92;
    let hi = pow((c + 0.055) / 1.055, vec3<f32>(2.4));
    return select(hi, lo, c <= vec3<f32>(0.04045));
}

// Colours are authored in sRGB; an sRGB render target encodes on write, so decode first.
fn out_color(c: vec4<f32>) -> vec4<f32> {
    if (g.srgb_target > 0.5) {
        return vec4<f32>(srgb_to_linear(c.rgb), c.a);
    }
    return c;
}

// ─── Shapes ────────────────────────────────────────────────────────────────

struct ShapeOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) params: vec4<f32>,
    @location(3) size: vec2<f32>,
};

@vertex
fn vs_shape(
    @builtin(vertex_index) vi: u32,
    @location(0) rect: vec4<f32>,
    @location(1) color: vec4<f32>,
    @location(2) params: vec4<f32>,
) -> ShapeOut {
    let c = corner(vi);
    var o: ShapeOut;
    o.pos = to_clip(rect.xy + c * rect.zw);
    o.uv = c * 2.0 - 1.0;
    o.color = color;
    o.params = params;
    o.size = rect.zw;
    return o;
}

fn ring(r: f32, a: f32, b: f32, aa: f32) -> f32 {
    return smoothstep(a - aa, a + aa, r) * (1.0 - smoothstep(b - aa, b + aa, r));
}

fn platter(uv: vec2<f32>, deck: vec3<f32>, angle: f32, loaded: f32, size: f32) -> vec4<f32> {
    let r = length(uv);
    let aa = 2.0 / size;
    if (r > 1.0 + aa) {
        discard;
    }
    // Angle measured clockwise from 12 o'clock, then moved into the record's own frame.
    let theta = atan2(uv.x, -uv.y);
    let local = theta - angle;
    let accent = mix(vec3<f32>(0.55), deck, loaded);
    // Vinyl: near-black with fine grooves and a light-fixed anisotropic sheen.
    let base = mix(vec3<f32>(0.06), vec3<f32>(0.80), 1.0 - g.dark);
    let groove = 0.5 + 0.5 * sin(r * size * 0.9);
    let sheen = pow(abs(cos(theta * 2.0 + 0.6)), 24.0) * 0.18;
    var col = base * (0.85 + 0.15 * groove) + vec3<f32>(sheen);
    // Rotating texture: faint radial stripes in the record frame make rotation visible.
    let stripes = smoothstep(0.92, 1.0, abs(cos(local * 8.0)));
    col = col + vec3<f32>(0.05) * stripes * step(0.32, r) * step(r, 0.88);
    // Outer rim in the deck colour.
    col = mix(col, accent * 0.75, ring(r, 0.90, 1.0, aa));
    // Label with a rotating half.
    let label = 1.0 - smoothstep(0.30 - aa, 0.30 + aa, r);
    let half_mark = step(0.0, cos(local)) * 0.25 + 0.75;
    col = mix(col, accent * half_mark, label);
    // Position marker: wedge at 0 rad in the record frame, across the grooves.
    let wrapped = atan2(sin(local), cos(local));
    let wedge = 1.0 - smoothstep(0.035 - aa, 0.035 + aa, abs(wrapped));
    col = mix(col, vec3<f32>(1.0, 0.98, 0.94), wedge * ring(r, 0.34, 0.98, aa));
    // Spindle.
    col = mix(col, base, 1.0 - smoothstep(0.035 - aa, 0.035 + aa, r));
    let alpha = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
    return vec4<f32>(col, alpha);
}

@fragment
fn fs_shape(i: ShapeOut) -> @location(0) vec4<f32> {
    let kind = i.params.x;
    if (kind < 0.5) {
        return out_color(i.color);
    }
    if (kind < 1.5) {
        return out_color(platter(i.uv, i.color.rgb, i.params.y, i.params.z, min(i.size.x, i.size.y)));
    }
    let d = length(i.uv);
    if (d > 1.0) {
        discard;
    }
    return out_color(vec4<f32>(i.color.rgb, i.color.a * (1.0 - smoothstep(0.6, 1.0, d))));
}

// ─── Waveforms ─────────────────────────────────────────────────────────────

struct WaveOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) @interpolate(flat) rect: vec4<f32>,
    @location(1) @interpolate(flat) t: vec4<f32>,
    @location(2) @interpolate(flat) info: vec4<u32>,
    @location(3) @interpolate(flat) color: vec4<f32>,
};

@vertex
fn vs_wave(
    @builtin(vertex_index) vi: u32,
    @location(0) rect: vec4<f32>,
    @location(1) t: vec4<f32>,
    @location(2) info: vec4<u32>,
    @location(3) color: vec4<f32>,
) -> WaveOut {
    var o: WaveOut;
    o.pos = to_clip(rect.xy + corner(vi) * rect.zw);
    o.rect = rect;
    o.t = t;
    o.info = info;
    o.color = color;
    return o;
}

struct Band {
    lo: f32,
    hi: f32,
    rms: f32,
};

fn unpack(w: u32) -> Band {
    var b: Band;
    b.lo = f32(w & 0xffu) / 127.5 - 1.0;
    b.hi = f32((w >> 8u) & 0xffu) / 127.5 - 1.0;
    b.rms = f32((w >> 16u) & 0xffu) / 255.0;
    return b;
}

fn merge(a: Band, b: Band) -> Band {
    var o: Band;
    o.lo = min(a.lo, b.lo);
    o.hi = max(a.hi, b.hi);
    o.rms = max(a.rms, b.rms);
    return o;
}

fn band_shade(c: vec3<f32>, b: Band, v: f32) -> vec4<f32> {
    // Inside the RMS body: full colour; peak fringe: dimmer.
    let body = step(abs(v), b.rms);
    return vec4<f32>(c * mix(0.62, 1.0, body), 1.0);
}

fn inside(b: Band, v: f32) -> bool {
    return v >= b.lo && v <= b.hi;
}

@fragment
fn fs_wave(i: WaveOut) -> @location(0) vec4<f32> {
    let px = i.pos.x - i.rect.x;
    let t0 = i.t.x + floor(px) * i.t.y;
    let t1 = t0 + i.t.y;
    let pps = i.t.z;
    let count = i.info.y;
    let p0 = i32(floor(t0 * pps));
    let p1 = i32(floor(t1 * pps));
    if (p1 < 0 || p0 >= i32(count)) {
        discard;
    }
    let a = u32(max(p0, 0));
    let b = u32(clamp(p1, i32(a), i32(count) - 1));
    // Zoomed far out a column covers many points: sample at most 32 of them.
    let stride = max(1u, (b - a + 32u) / 32u);
    let base = i.info.x;
    var lo = Band(1.0, -1.0, 0.0);
    var mi = Band(1.0, -1.0, 0.0);
    var hi = Band(1.0, -1.0, 0.0);
    for (var p = a; p <= b; p = p + stride) {
        let k = (base + p) * 3u;
        lo = merge(lo, unpack(peaks[k]));
        mi = merge(mi, unpack(peaks[k + 1u]));
        hi = merge(hi, unpack(peaks[k + 2u]));
    }
    let half = i.rect.w * 0.5;
    let v = (i.rect.y + half - i.pos.y) / half;
    let style = i.info.z;
    if (style == 0u) {
        // Nested RGB bands, treble in front.
        if (inside(hi, v)) {
            return out_color(band_shade(g.high.rgb, hi, v));
        }
        if (inside(mi, v)) {
            return out_color(band_shade(g.mid.rgb, mi, v));
        }
        if (inside(lo, v)) {
            return out_color(band_shade(g.low.rgb, lo, v));
        }
        discard;
    }
    let all = merge(merge(lo, mi), hi);
    if (!inside(all, v)) {
        discard;
    }
    if (style == 1u) {
        return out_color(band_shade(i.color.rgb, all, v));
    }
    // Spectral: colour from the band energy balance, bass warm → treble cool.
    let e = vec3<f32>(lo.rms, mi.rms, hi.rms) + vec3<f32>(1e-3);
    let w = e / (e.x + e.y + e.z);
    let warm = vec3<f32>(1.0, 0.36, 0.18);
    let neutral = vec3<f32>(0.98, 0.86, 0.32);
    let cool = vec3<f32>(0.30, 0.62, 1.0);
    let c = warm * w.x + neutral * w.y + cool * w.z;
    return out_color(band_shade(c, all, v));
}
