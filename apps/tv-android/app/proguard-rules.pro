# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class ro.mixai.tv.**$$serializer { *; }
-keepclassmembers class ro.mixai.tv.** { *** Companion; }
-keepclasseswithmembers class ro.mixai.tv.** { kotlinx.serialization.KSerializer serializer(...); }
