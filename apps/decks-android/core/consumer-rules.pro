# UniFFI bindings call into JNA by reflection.
-keep class com.sun.jna.** { *; }
-keep class * implements com.sun.jna.** { *; }
-keep class ro.mixai.decks.ffi.** { *; }
