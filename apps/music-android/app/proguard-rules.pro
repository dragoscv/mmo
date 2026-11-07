# kotlinx.serialization rules for :core come from core/consumer-rules.pro.
# Music-app and :mobile-common serializable classes (NativeSession, prefs).
-keep,includedescriptorclasses class ro.mixai.music.**$$serializer { *; }
-keepclassmembers class ro.mixai.music.** { *** Companion; }
-keepclasseswithmembers class ro.mixai.music.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class ro.mixai.mobile.**$$serializer { *; }
-keepclassmembers class ro.mixai.mobile.** { *** Companion; }
-keepclasseswithmembers class ro.mixai.mobile.** { kotlinx.serialization.KSerializer serializer(...); }
