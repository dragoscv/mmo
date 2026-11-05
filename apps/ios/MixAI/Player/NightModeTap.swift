import AVFoundation
import MediaToolbox
import MixaiCore
import os

/// Night mode (D38): a tiny feed-forward compressor (`NightCompressor`) inserted with an `MTAudioProcessingTap`
/// on the first audio track: loud scenes come down, dialogue comes up.
///
/// Limitation (accepted): AVFoundation only runs processing taps for assets it decodes locally — downloaded/offline
/// files and progressive (direct) streams. For HLS the `audioMix` is silently ignored, so night mode does nothing
/// there. The VLC engine has no tap at all (the OSD marks the toggle unavailable).
enum NightModeTap {
    /// Builds an audio mix for `item`, nil when the asset has no audio track or the tap cannot be created.
    @MainActor
    static func makeAudioMix(for item: AVPlayerItem) async -> AVAudioMix? {
        guard let tracks = try? await item.asset.loadTracks(withMediaType: .audio), let track = tracks.first else { return nil }
        guard let tap = makeTap() else { return nil }
        let params = AVMutableAudioMixInputParameters(track: track)
        params.audioTapProcessor = tap
        let mix = AVMutableAudioMix()
        mix.inputParameters = [params]
        return mix
    }

    /// Nonisolated on purpose: the C callbacks below must not inherit main-actor isolation.
    nonisolated private static func makeTap() -> MTAudioProcessingTap? {
        let info = Unmanaged.passRetained(CompressorBox()).toOpaque()
        // C callbacks: non-capturing closures only; state flows through the tap storage pointer.
        var callbacks = MTAudioProcessingTapCallbacks(
            version: kMTAudioProcessingTapCallbacksVersion_0,
            clientInfo: info,
            init: { _, clientInfo, tapStorageOut in
                // The +1 retain from `passRetained` moves into the tap storage; finalize releases it.
                tapStorageOut.pointee = clientInfo
            },
            finalize: { tap in
                Unmanaged<CompressorBox>.fromOpaque(UnsafeRawPointer(MTAudioProcessingTapGetStorage(tap))).release()
            },
            prepare: { tap, _, format in
                let box = Unmanaged<CompressorBox>.fromOpaque(UnsafeRawPointer(MTAudioProcessingTapGetStorage(tap))).takeUnretainedValue()
                let f = format.pointee
                box.setFloat(f.mFormatID == kAudioFormatLinearPCM && (f.mFormatFlags & kAudioFormatFlagIsFloat) != 0 && f.mBitsPerChannel == 32)
            },
            unprepare: nil,
            process: { tap, numberFrames, _, bufferListInOut, numberFramesOut, flagsOut in
                let status = MTAudioProcessingTapGetSourceAudio(tap, numberFrames, bufferListInOut, flagsOut, nil, numberFramesOut)
                guard status == noErr else { return }
                let box = Unmanaged<CompressorBox>.fromOpaque(UnsafeRawPointer(MTAudioProcessingTapGetStorage(tap))).takeUnretainedValue()
                guard box.isFloat else { return }  // not Float32 PCM → pass through untouched
                let buffers = UnsafeMutableAudioBufferListPointer(bufferListInOut)
                var sumSquares: Float = 0
                var count = 0
                for buf in buffers {
                    guard let data = buf.mData else { continue }
                    let n = Int(buf.mDataByteSize) / MemoryLayout<Float>.size
                    let samples = data.bindMemory(to: Float.self, capacity: n)
                    for i in 0..<n { sumSquares += samples[i] * samples[i] }
                    count += n
                }
                guard count > 0 else { return }
                let g = box.gain(rms: (sumSquares / Float(count)).squareRoot())
                for buf in buffers {
                    guard let data = buf.mData else { continue }
                    let n = Int(buf.mDataByteSize) / MemoryLayout<Float>.size
                    let samples = data.bindMemory(to: Float.self, capacity: n)
                    for i in 0..<n { samples[i] = max(-1, min(1, samples[i] * g)) }
                }
            }
        )
        var tapOut: MTAudioProcessingTap?
        let status = MTAudioProcessingTapCreate(kCFAllocatorDefault, &callbacks, kMTAudioProcessingTapCreationFlag_PostEffects, &tapOut)
        guard status == noErr, let tap = tapOut else {
            // init never ran → balance the retain ourselves.
            Unmanaged<CompressorBox>.fromOpaque(UnsafeRawPointer(info)).release()
            return nil
        }
        return tap
    }
}

/// Compressor state shared with the real-time audio thread (lock-protected; never touches actor state).
final class CompressorBox: @unchecked Sendable {
    private struct State: Sendable {
        var comp = NightCompressor()
        var isFloat = false
    }

    private let lock = OSAllocatedUnfairLock(initialState: State())

    var isFloat: Bool { lock.withLock { $0.isFloat } }

    func setFloat(_ value: Bool) { lock.withLock { $0.isFloat = value } }

    func gain(rms: Float) -> Float {
        lock.withLock { $0.comp.process(rms: rms) }
    }
}
