# kotlinx-serialization and OkHttp ship consumer rules; these optional TLS providers are never present on Wear.
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
