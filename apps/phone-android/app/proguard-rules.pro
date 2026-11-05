# kotlinx.serialization rules for :core come from core/consumer-rules.pro.
# Phone-only serializable classes (nav keys, prefs) live under ro.mixai.app.
-keep,includedescriptorclasses class ro.mixai.app.**$$serializer { *; }
-keepclassmembers class ro.mixai.app.** { *** Companion; }
-keepclasseswithmembers class ro.mixai.app.** { kotlinx.serialization.KSerializer serializer(...); }
