import AVFoundation
import CoreImage
import MediaPlayer
import MixaiCore
import UIKit

/// UIImage is immutable once created; safe to hand to the system's artwork callbacks.
private struct UncheckedImage: @unchecked Sendable { let image: UIImage }

/// iOS 26 Lock Screen animated artwork (`MPMediaItemAnimatedArtwork`) without server video: a slow, seamless
/// Ken Burns loop rendered from the album cover into a small H.264 file, cached per album and aspect ratio.
enum AnimatedArtwork {
    /// One artwork object per album (the system caches by `artworkID`).
    @MainActor private static var items: [String: MPMediaItemAnimatedArtwork] = [:]

    @MainActor
    static func item(albumId: String, image: UIImage) -> MPMediaItemAnimatedArtwork? {
        if let a = items[albumId] { return a }
        let art = MPMediaItemAnimatedArtwork(artworkID: "mixai-music-kb-\(albumId)-v1",
                                             previewImageRequestHandler: previewHandler(image),
                                             videoAssetFileURLRequestHandler: videoHandler(albumId: albumId, image: image))
        if items.count > 32 { items.removeAll() }
        items[albumId] = art
        return art
    }

    /// Built outside the main actor so the closures are not main-actor isolated (the system calls them anywhere).
    nonisolated private static func previewHandler(_ image: UIImage) -> @Sendable (CGSize, @escaping @Sendable (UIImage?) -> Void) -> Void {
        let still = UncheckedImage(image: image)
        return { size, completion in completion(still.image.preparingThumbnail(of: size) ?? still.image) }
    }

    nonisolated private static func videoHandler(albumId: String, image: UIImage) -> @Sendable (CGSize, @escaping @Sendable (URL?) -> Void) -> Void {
        let still = UncheckedImage(image: image)
        return { size, completion in
            Task.detached(priority: .utility) {
                completion(try? await render(albumId: albumId, image: still.image, size: size))
            }
        }
    }

    nonisolated static func fileURL(albumId: String, w: Int, h: Int) -> URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("mixai-animated", isDirectory: true)
            .appendingPathComponent(MusicOffline.fileName(id: "\(albumId)-\(w)x\(h)", ext: "mp4"))
    }

    /// 8 s loop at 30 fps: zoom 1.0 → 1.12 → 1.0 with a gentle drift (sine, so the first and last frames match).
    nonisolated static func render(albumId: String, image: UIImage, size: CGSize) async throws -> URL {
        // Keep files small: cap the long side at 720 px, even dimensions for H.264.
        let scale = min(1, 720 / max(size.width, size.height, 1))
        let w = max(2, Int(size.width * scale) / 2 * 2), h = max(2, Int(size.height * scale) / 2 * 2)
        let out = fileURL(albumId: albumId, w: w, h: h)
        if FileManager.default.fileExists(atPath: out.path) { return out }
        try FileManager.default.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
        let tmp = out.deletingPathExtension().appendingPathExtension("tmp.mp4")
        try? FileManager.default.removeItem(at: tmp)
        guard let cg = image.cgImage else { throw CocoaError(.fileReadCorruptFile) }

        let writer = try AVAssetWriter(outputURL: tmp, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: w, AVVideoHeightKey: h,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 1_200_000, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel],
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h,
        ])
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
        writer.startSession(atSourceTime: .zero)

        let fps = 30, frames = 8 * fps
        let src = CIImage(cgImage: cg)
        let ctx = CIContext(options: [.cacheIntermediates: false])
        // Cover the target aspect (square covers in a 3:4 frame get cropped left/right).
        let base = max(Double(w) / src.extent.width, Double(h) / src.extent.height)
        for i in 0..<frames {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
            let phase = Double(i) / Double(frames) * 2 * .pi
            let zoom = base * (1.06 - 0.06 * cos(phase))
            let dx = sin(phase) * Double(w) * 0.02, dy = sin(phase * 2) * Double(h) * 0.01
            let sw = src.extent.width * zoom, sh = src.extent.height * zoom
            let t = CGAffineTransform(scaleX: zoom, y: zoom)
                .concatenating(CGAffineTransform(translationX: (Double(w) - sw) / 2 + dx, y: (Double(h) - sh) / 2 + dy))
            let frame = src.transformed(by: t).cropped(to: CGRect(x: 0, y: 0, width: w, height: h))
            guard let pool = adaptor.pixelBufferPool else { break }
            var pb: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb)
            guard let pb else { break }
            ctx.render(frame, to: pb)
            adaptor.append(pb, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: CMTimeScale(fps)))
        }
        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
        try? FileManager.default.removeItem(at: out)
        try FileManager.default.moveItem(at: tmp, to: out)
        return out
    }
}
