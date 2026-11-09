# UniFFI bindings + JNA direct mapping (AndroidNative) are reflective.
-keep class com.sun.jna.** { *; }
-keep class * implements com.sun.jna.** { *; }
-keep class ro.mixai.decks.ffi.** { *; }
-keep class ro.mixai.decks.ui.platform.AndroidNative { *; }
-dontwarn java.awt.**
