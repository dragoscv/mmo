# :listen-core ships consumer rules for JNA + the UniFFI bindings.
-keep,includedescriptorclasses class ro.mixai.mobile.**$$serializer { *; }
-keepclassmembers class ro.mixai.mobile.** { *** Companion; }
-keepclasseswithmembers class ro.mixai.mobile.** { kotlinx.serialization.KSerializer serializer(...); }
-dontwarn java.awt.**
# ShazamKit (Song ID): the AAR's own consumer rules keep its internals; Retrofit/Gson reflection needs these.
-keepattributes Signature, InnerClasses, EnclosingMethod, RuntimeVisibleAnnotations, AnnotationDefault
-keep class com.shazam.** { *; }
-dontwarn com.shazam.**
-dontwarn retrofit2.**
-dontwarn org.codehaus.mojo.animal_sniffer.**
