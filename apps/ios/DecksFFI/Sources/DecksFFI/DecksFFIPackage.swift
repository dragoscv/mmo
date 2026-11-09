// Committed placeholder so the DecksFFI target always has a source file. The real API (DecksEngine,
// DecksLibrary, DecksMapping, DecksRenderer, …) is the generated DecksFFI.swift next to this file, written by
// apps/ios/scripts/build-decks-xcframework.sh (docs/decks/ffi.md).
public enum DecksFFIPackage {
    public static let generator = "uniffi 0.32 (decks-ffi)"
}
