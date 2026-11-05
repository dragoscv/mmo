package ro.mixai.tv.ui.components

// Rendering switches for on-device performance experiments, read once at start from the
// `debug.mixai.perf` system property (comma list), e.g.
//   adb shell setprop debug.mixai.perf noglow,nocrossfade
// Empty / unset = everything on. Never used to ship different behaviour.
object PerfFlags {
    private val flags: Set<String> by lazy {
        runCatching {
            val c = Class.forName("android.os.SystemProperties")
            val v = c.getMethod("get", String::class.java, String::class.java).invoke(null, "debug.mixai.perf", "") as String
            v.split(',').map { it.trim() }.filter { it.isNotEmpty() }.toSet()
        }.getOrDefault(emptySet())
    }
    val noGlow get() = "noglow" in flags
    val noCrossfade get() = "nocrossfade" in flags
    val noBackdrop get() = "nobackdrop" in flags
    val noScrim get() = "noscrim" in flags
    val noHero get() = "nohero" in flags
    val noSqueeze get() = "nosqueeze" in flags
    val noRail get() = "norail" in flags
    val noShared get() = "noshared" in flags
    val noLayerCache get() = "nolayercache" in flags
    val noKenBurns get() = "nokenburns" in flags
    val noEntrance get() = "noentrance" in flags
    val noFont get() = "nofont" in flags
}
