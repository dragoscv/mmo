// Committed placeholder so the KeyBpmFFI target always has a source file. The real API (KeyBpmEngine, analyzeFile,
// keyLabel, compatibleKeys, transitionScore, …) is the generated mixai_listen_ffi.swift next to this file, written by
// apps/ios/scripts/build-keybpm-xcframework.sh.
public enum KeyBpmFFIPackage {
    public static let generator = "uniffi 0.32 (mixai-listen-ffi)"
}
