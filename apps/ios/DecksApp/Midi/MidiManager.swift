import CoreMIDI
import DecksFFI
import Foundation
import Observation

/// CoreMIDI transport (USB, network sessions and — on iOS — Bluetooth LE MIDI devices paired through
/// `CABTMIDICentralViewController`, which CoreMIDI exposes as ordinary sources). Raw MIDI 1.0 bytes are fed to
/// the Rust mapping engine (`DecksMapping.onMidi`, one mapping per source, profile picked by `detect`), the
/// resulting actions go to `MidiDispatcher`, and LED feedback goes back to the matching destination.
@MainActor
@Observable
final class MidiManager {
    struct Device: Identifiable, Equatable {
        let id: MIDIUniqueID
        let name: String
        let profile: String
    }

    private(set) var devices: [Device] = []
    private(set) var lastMessage: String?
    private(set) var available = true

    @ObservationIgnored private var client = MIDIClientRef()
    @ObservationIgnored private var input = MIDIPortRef()
    @ObservationIgnored private var output = MIDIPortRef()
    @ObservationIgnored private var sources: [MIDIUniqueID: (endpoint: MIDIEndpointRef, mapping: DecksMapping, name: String)] = [:]
    @ObservationIgnored private var dispatcher: MidiDispatcher?
    @ObservationIgnored private var feedbackTask: Task<Void, Never>?
    @ObservationIgnored private weak var store: DecksStore?
    @ObservationIgnored private var tags: [Int: MIDIUniqueID] = [:]
    @ObservationIgnored private var nextTag = 0

    func start(store: DecksStore, dispatcher: MidiDispatcher) {
        guard client == 0 else { return }
        self.store = store
        self.dispatcher = dispatcher
        let notify = Self.makeNotifyBlock(owner: self)
        var status = MIDIClientCreateWithBlock("MixAI Decks" as CFString, &client, notify)
        guard status == noErr else { available = false; return }
        status = MIDIInputPortCreateWithProtocol(client, "MixAI Decks In" as CFString, ._1_0, &input, Self.makeReceiveBlock(owner: self))
        guard status == noErr else { available = false; return }
        MIDIOutputPortCreate(client, "MixAI Decks Out" as CFString, &output)
        rescan()
        feedbackTask = Task { [weak self] in
            while !Task.isCancelled {
                self?.sendFeedback()
                try? await Task.sleep(for: .milliseconds(66))
            }
        }
    }

    /// Re-lists sources and connects the new ones (called on CoreMIDI setup changes).
    func rescan() {
        var seen = Set<MIDIUniqueID>()
        for i in 0..<MIDIGetNumberOfSources() {
            let src = MIDIGetSource(i)
            guard let id = Self.uniqueID(src) else { continue }
            seen.insert(id)
            if sources[id] != nil { continue }
            let name = Self.displayName(src)
            let mapping = (try? DecksMapping.detect(portName: name, usbVendor: nil, usbProduct: nil, identityReply: nil))
                ?? (try? DecksMapping.fromBuiltin(id: "generic"))
            guard let mapping else { continue }
            sources[id] = (src, mapping, name)
            nextTag += 1
            tags[nextTag] = id
            MIDIPortConnectSource(input, src, UnsafeMutableRawPointer(bitPattern: nextTag))
        }
        for (id, s) in sources where !seen.contains(id) {
            MIDIPortDisconnectSource(input, s.endpoint)
            sources[id] = nil
        }
        devices = sources.map { Device(id: $0.key, name: $0.value.name, profile: $0.value.mapping.profile().name) }
            .sorted { $0.name < $1.name }
    }

    fileprivate func receive(sourceTag: Int, messages: [[UInt8]], timestampUs: UInt64) {
        guard let id = tags[sourceTag], let src = sources[id] else { return }
        for bytes in messages where !bytes.isEmpty {
            let actions = src.mapping.onMidi(port: src.name, bytes: Data(bytes), timestampUs: timestampUs)
            if let first = actions.first { lastMessage = "\(src.name): \(first.group).\(first.kind)" }
            for a in actions { dispatcher?.handle(a) }
        }
    }

    private func sendFeedback() {
        guard let snap = store?.latest, output != 0 else { return }
        for (_, s) in sources {
            let out = s.mapping.feedbackFromSnapshot(snapshot: snap)
            guard !out.isEmpty, let dest = Self.destination(named: s.name) else { continue }
            Self.send(out.map { [UInt8]($0.bytes) }, port: output, to: dest)
        }
    }

    // MARK: CoreMIDI helpers (nonisolated: CoreMIDI calls the blocks on its own thread)

    nonisolated private static func makeNotifyBlock(owner: MidiManager) -> MIDINotifyBlock {
        { [weak owner] note in
            guard note.pointee.messageID == .msgSetupChanged else { return }
            let o = owner
            Task { @MainActor in o?.rescan() }
        }
    }

    nonisolated private static func makeReceiveBlock(owner: MidiManager) -> MIDIReceiveBlock {
        { [weak owner] list, refCon in
            let tag = Int(bitPattern: refCon)
            let messages = midi1Messages(list)
            let ts = DispatchTime.now().uptimeNanoseconds / 1000
            guard !messages.isEmpty else { return }
            let o = owner
            Task { @MainActor in o?.receive(sourceTag: tag, messages: messages, timestampUs: ts) }
        }
    }

    /// MIDI 1.0 byte messages from a UMP event list (channel voice = type 2, system real-time/common = type 1).
    nonisolated static func midi1Messages(_ list: UnsafePointer<MIDIEventList>) -> [[UInt8]] {
        var out: [[UInt8]] = []
        for packet in list.unsafeSequence() {
            var copy = packet.pointee
            let n = Int(copy.wordCount)
            let words = withUnsafeBytes(of: &copy.words) { raw in
                Array(raw.bindMemory(to: UInt32.self).prefix(n))
            }
            out.append(contentsOf: decode(words))
        }
        return out
    }

    nonisolated static func decode(_ words: [UInt32]) -> [[UInt8]] {
        var out: [[UInt8]] = []
        var i = 0
        while i < words.count {
            let w = words[i]
            let type = w >> 28
            let status = UInt8((w >> 16) & 0xFF)
            let d1 = UInt8((w >> 8) & 0x7F)
            let d2 = UInt8(w & 0x7F)
            switch type {
            case 0x2:
                let hi = status & 0xF0
                out.append(hi == 0xC0 || hi == 0xD0 ? [status, d1] : [status, d1, d2])
                i += 1
            case 0x1:
                switch status {
                case 0xF1, 0xF3: out.append([status, d1])
                case 0xF2: out.append([status, d1, d2])
                default: out.append([status])
                }
                i += 1
            case 0x3, 0x4: i += 2
            case 0x5: i += 4
            default: i += 1
            }
        }
        return out
    }

    nonisolated private static func send(_ messages: [[UInt8]], port: MIDIPortRef, to dest: MIDIEndpointRef) {
        // One channel-voice message per event list: no packet-capacity bookkeeping, LED traffic is small.
        for m in messages where m.count >= 2 && m[0] >= 0x80 && m[0] < 0xF0 {
            var word: UInt32 = 0x2000_0000 | UInt32(m[0]) << 16 | UInt32(m[1] & 0x7F) << 8 | UInt32(m.count > 2 ? m[2] & 0x7F : 0)
            var list = MIDIEventList()
            withUnsafeMutablePointer(to: &list) { lp in
                let packet = MIDIEventListInit(lp, ._1_0)
                _ = MIDIEventListAdd(lp, MemoryLayout<MIDIEventList>.size, packet, 0, 1, &word)
                MIDISendEventList(port, dest, lp)
            }
        }
    }

    nonisolated private static func uniqueID(_ obj: MIDIObjectRef) -> MIDIUniqueID? {
        var id: MIDIUniqueID = 0
        return MIDIObjectGetIntegerProperty(obj, kMIDIPropertyUniqueID, &id) == noErr ? id : nil
    }

    nonisolated private static func displayName(_ obj: MIDIObjectRef) -> String {
        var name: Unmanaged<CFString>?
        if MIDIObjectGetStringProperty(obj, kMIDIPropertyDisplayName, &name) == noErr, let n = name?.takeRetainedValue() {
            return n as String
        }
        return "MIDI"
    }

    nonisolated private static func destination(named name: String) -> MIDIEndpointRef? {
        for i in 0..<MIDIGetNumberOfDestinations() {
            let d = MIDIGetDestination(i)
            if displayName(d) == name { return d }
        }
        return nil
    }
}
