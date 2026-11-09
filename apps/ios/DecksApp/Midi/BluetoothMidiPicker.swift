#if os(iOS)
import CoreAudioKit
import SwiftUI
import UIKit

/// Apple's Bluetooth LE MIDI central picker. Devices connected here appear as CoreMIDI sources, which
/// `MidiManager` picks up on the next setup change.
struct BluetoothMidiPicker: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UINavigationController {
        let central = CABTMIDICentralViewController()
        central.navigationItem.title = String(localized: "midi.bluetooth.title")
        return UINavigationController(rootViewController: central)
    }

    func updateUIViewController(_ controller: UINavigationController, context: Context) {}
}
#endif
