import DecksFFI
import QuartzCore
import SwiftUI

/// Hosts the Rust wgpu deck renderer (`DecksRenderer.fromMetalLayer`) in a CAMetalLayer-backed view.
/// A display link (CADisplayLink on iOS, NSView.displayLink on macOS 14+) drives update + render on the main
/// thread; peaks are uploaded once per track load. Falls back to a token-coloured placeholder if the GPU
/// surface cannot be created.
struct WaveformView: View {
    let store: DecksStore
    let views: (CGSize) -> [RenderView]

    var body: some View {
        WaveformHost(store: store, views: views)
            .background(DecksTheme.surface)
            .accessibilityElement()
            .accessibilityLabel(Text("waveform.a11y"))
            .accessibilityAddTraits(.updatesFrequently)
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
