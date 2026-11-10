// Placeholder so the LiveFFI module always has a source file. The generated bindings (LiveFFI.swift) are written
// next to it by scripts/build-live-xcframework.sh (gitignored).
public enum LiveFFIPackage {
    /// True when the Rust engine is linked (the generated xcframework was present at build time).
    #if canImport(live_ffiFFI)
    public static let hasEngine = true
    #else
    public static let hasEngine = false
    #endif
}
