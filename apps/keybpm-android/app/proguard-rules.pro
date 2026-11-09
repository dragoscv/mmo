# :listen-core ships consumer rules for JNA + the UniFFI bindings.
-keep,includedescriptorclasses class ro.mixai.mobile.**$$serializer { *; }
-keepclassmembers class ro.mixai.mobile.** { *** Companion; }
-keepclasseswithmembers class ro.mixai.mobile.** { kotlinx.serialization.KSerializer serializer(...); }
-dontwarn java.awt.**
