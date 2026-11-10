import DecksFFI
import Observation
import QuartzCore
import SwiftUI

/// Hosts the Rust wgpu deck renderer (`DecksRenderer.fromMetalLayer`) in a CAMetalLayer-backed view.
/// A display link (CADisplayLink on iOS, NSView.displayLink on macOS 14+) drives update + render on the main
/// thread; peaks are uploaded once per track load. Falls back to a token-coloured placeholder if the GPU
/// surface cannot be created.
struct WaveformView: View {
    let store: DecksStore
    let views: (CGSize) -> [RenderView]
    /// Flexible grids per deck lane (WP19-37). When set, a SwiftUI overlay draws the beat lines
    /// that follow every tempo marker, the markers themselves and a fixed-grid bar (the GPU renderer
    /// only knows a constant grid). Empty = read the grid of the loaded track from the library
    /// (once per deck + track id, never per frame).
    var grids: [GridOverlayLane] = []

    @Environment(LibraryStore.self) private var library
    /// Grid of the track loaded on each deck, read through the FFI when the deck's track changes.
    @State private var loaded: [Int: LoadedTrackGrid] = [:]
    /// Bumped by the beatgrid editor (same track id, new grid).
    @State private var revision = GridRevision.shared

    var body: some View {
        GeometryReader { geo in
            let lanes = grids.isEmpty ? overlayLanes(size: geo.size) : grids
            WaveformHost(store: store, views: views)
                .overlay { if !lanes.isEmpty { GridOverlay(lanes: lanes) } }
                .frame(width: geo.size.width, height: geo.size.height)
        }
        .background(DecksTheme.surface)
        .accessibilityElement()
        .accessibilityLabel(Text("waveform.a11y"))
        .accessibilityAddTraits(.updatesFrequently)
        .onAppear { refreshGrids() }
        .onChange(of: library.loadedTrackIds) { _, _ in refreshGrids() }
        .onChange(of: revision.value) { _, _ in refreshGrids(force: true) }
    }

    /// One overlay lane per scrolling-waveform view of the renderer, in the same rectangle the GPU
    /// draws that deck into (overview lanes keep the GPU grid only).
    private func overlayLanes(size: CGSize) -> [GridOverlayLane] {
        guard !loaded.isEmpty, size.width > 1, size.height > 1 else { return [] }
        var out: [GridOverlayLane] = []
        for v in views(size) {
            guard case let .waveform(deck) = v.kind, let g = loaded[Int(deck)] else { continue }
            out.append(
                GridOverlayLane(
                    grid: g.grid,
                    playheadSec: store.deck(Int(deck))?.playheadSec ?? 0,
                    zoomSeconds: Double(store.zoomSeconds),
                    rect: CGRect(x: CGFloat(v.x), y: CGFloat(v.y), width: CGFloat(v.w), height: CGFloat(v.h))
                )
            )
        }
        return out
    }

    /// Re-read the grids that changed track (`force` also re-reads after an edit in the grid editor).
    private func refreshGrids(force: Bool = false) {
        guard let lib = library.library else {
            if !loaded.isEmpty { loaded = [:] }
            return
        }
        var next: [Int: LoadedTrackGrid] = [:]
        for deck in 0..<DecksStore.deckCount {
            guard let tid = library.loadedTrackIds[deck] else { continue }
            if !force, let cur = loaded[deck], cur.trackId == tid {
                next[deck] = cur
                continue
            }
            if let g = try? trackGrid(library: lib, trackId: tid) {
                next[deck] = LoadedTrackGrid(trackId: tid, grid: g)
            }
        }
        if next != loaded { loaded = next }
    }
}

/// The grid currently drawn for one deck, with the track it belongs to (so it is read once).
struct LoadedTrackGrid: Equatable {
    var trackId: String
    var grid: GridState
}

/// Bumped when the beatgrid editor writes a change, so the waveform overlay re-reads the grid of a
/// track that is already loaded (the track id does not change, so the cache alone would not notice).
@MainActor
@Observable
final class GridRevision {
    static let shared = GridRevision()
    private(set) var value = 0
    func bump() { value &+= 1 }
}

/// One lane of the grid overlay: the grid, the playhead and the visible span in seconds.
/// UNVERIFIED on device (Swift is not built on the Windows workstation).
struct GridOverlayLane: Equatable {
    var grid: GridState
    var playheadSec: Double
    var zoomSeconds: Double
    /// Rectangle of the lane inside the waveform view, in points. `.zero` = split the height evenly.
    var rect: CGRect = .zero
}

/// Beat lines (downbeats brighter), tempo markers in the warning colour with their BPM, and a
/// warning bar on top of a lane whose grid is fixed. Purely decorative for VoiceOver (the editor
/// carries the accessible controls).
struct GridOverlay: View {
    let lanes: [GridOverlayLane]

    var body: some View {
        Canvas { ctx, size in
            let laneH = size.height / CGFloat(max(1, lanes.count))
            for (i, lane) in lanes.enumerated() {
                let even = lane.rect.width < 1 || lane.rect.height < 1
                let y0 = even ? laneH * CGFloat(i) : lane.rect.minY
                let h = even ? laneH : lane.rect.height
                let x0 = even ? 0 : lane.rect.minX
                let w = even ? size.width : lane.rect.width
                let t0 = lane.playheadSec - lane.zoomSeconds / 2
                let t1 = t0 + lane.zoomSeconds
                let pxPerSec = w / CGFloat(max(lane.zoomSeconds, 0.001))
                let x = { (t: Double) in x0 + CGFloat(t - t0) * pxPerSec }
                for line in GridMath.beatLines(lane.grid, from: t0, to: t1) {
                    var p = Path()
                    p.move(to: CGPoint(x: x(line.sec), y: y0))
                    p.addLine(to: CGPoint(x: x(line.sec), y: y0 + h))
                    ctx.stroke(p, with: .color(.white.opacity(line.downbeat ? 0.45 : 0.15)), lineWidth: line.downbeat ? 1.5 : 0.75)
                }
                let markerColor = DecksTheme.warning.opacity(lane.grid.fixed ? 0.35 : 1)
                for m in lane.grid.markers where m.sec >= t0 && m.sec <= t1 {
                    var p = Path()
                    p.move(to: CGPoint(x: x(m.sec), y: y0))
                    p.addLine(to: CGPoint(x: x(m.sec), y: y0 + h))
                    ctx.stroke(p, with: .color(markerColor), lineWidth: 2)
                    ctx.draw(
                        Text(verbatim: String(format: "%.1f", m.bpm)).font(.caption2.monospacedDigit()).foregroundColor(markerColor),
                        at: CGPoint(x: x(m.sec) + 3, y: y0 + 2),
                        anchor: .topLeading
                    )
                }
                if lane.grid.fixed {
                    ctx.fill(Path(CGRect(x: x0, y: y0, width: w, height: 3)), with: .color(DecksTheme.warning.opacity(0.8)))
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Shared renderer driver for both platforms.
@MainActor
final class RendererDriver {
    private var renderer: DecksRenderer?
    private var seen: [Int] = Array(repeating: -1, count: DecksStore.deckCount)
    private var lastViews: [RenderView] = []
    private var failed = false
    weak var store: DecksStore?
    var views: (CGSize) -> [RenderView] = { _ in [] }

    func attach(view: AnyObject, uikit: Bool, size: CGSize, scale: CGFloat) {
        guard renderer == nil, !failed, size.width > 1, size.height > 1 else { return }
        let ptr = UInt64(UInt(bitPattern: Unmanaged.passUnretained(view).toOpaque()))
        do {
            renderer = try DecksRenderer.fromMetalLayer(viewPtr: ptr, uikit: uikit, width: UInt32(size.width * scale), height: UInt32(size.height * scale), scale: Float(scale))
            lastViews = []
            seen = Array(repeating: -1, count: DecksStore.deckCount)
        } catch {
            failed = true
            store?.rendererFailure = error.localizedDescription
        }
    }

    func resize(size: CGSize, scale: CGFloat) {
        guard let renderer, size.width > 1, size.height > 1 else { return }
        renderer.resize(width: UInt32(size.width * scale), height: UInt32(size.height * scale), scale: Float(scale))
        lastViews = []
    }

    func frame(size: CGSize) {
        guard let renderer, let store else { return }
        let v = views(size)
        if v != lastViews {
            renderer.setViews(views: v)
            lastViews = v
        }
        store.uploadPeaks(to: renderer, seen: &seen)
        renderer.update(frame: store.renderFrame(now: CACurrentMediaTime()))
        try? renderer.render()
    }

    func detach() { renderer = nil }
}

#if os(iOS)
import UIKit

final class MetalHostView: UIView {
    override class var layerClass: AnyClass { CAMetalLayer.self }
    let driver = RendererDriver()
    private var link: CADisplayLink?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil {
            let l = CADisplayLink(target: self, selector: #selector(step))
            l.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 60)
            l.add(to: .main, forMode: .common)
            link = l
        } else {
            link?.invalidate()
            link = nil
            driver.detach()
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let scale = traitCollection.displayScale
        driver.attach(view: self, uikit: true, size: bounds.size, scale: scale)
        driver.resize(size: bounds.size, scale: scale)
    }

    @objc private func step() { driver.frame(size: bounds.size) }
}

private struct WaveformHost: UIViewRepresentable {
    let store: DecksStore
    let views: (CGSize) -> [RenderView]

    func makeUIView(context: Context) -> MetalHostView {
        let v = MetalHostView()
        v.isOpaque = true
        v.driver.store = store
        v.driver.views = views
        return v
    }

    func updateUIView(_ v: MetalHostView, context: Context) {
        v.driver.store = store
        v.driver.views = views
    }
}
#elseif os(macOS)
import AppKit

final class MetalHostView: NSView {
    let driver = RendererDriver()
    private var link: CADisplayLink?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func makeBackingLayer() -> CALayer { CAMetalLayer() }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil {
            let l = displayLink(target: self, selector: #selector(step))
            l.add(to: .main, forMode: .common)
            link = l
        } else {
            link?.invalidate()
            link = nil
            driver.detach()
        }
    }

    override func layout() {
        super.layout()
        let scale = window?.backingScaleFactor ?? 2
        driver.attach(view: self, uikit: false, size: bounds.size, scale: scale)
        driver.resize(size: bounds.size, scale: scale)
    }

    @objc private func step() { driver.frame(size: bounds.size) }
}

private struct WaveformHost: NSViewRepresentable {
    let store: DecksStore
    let views: (CGSize) -> [RenderView]

    func makeNSView(context: Context) -> MetalHostView {
        let v = MetalHostView(frame: .zero)
        v.driver.store = store
        v.driver.views = views
        return v
    }

    func updateNSView(_ v: MetalHostView, context: Context) {
        v.driver.store = store
        v.driver.views = views
    }
}
#endif
