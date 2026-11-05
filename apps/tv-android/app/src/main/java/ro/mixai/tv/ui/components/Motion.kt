package ro.mixai.tv.ui.components

import android.content.Context
import android.provider.Settings
import androidx.compose.runtime.staticCompositionLocalOf
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import ro.mixai.tv.data.generated.Profile
import ro.mixai.tv.ui.profiles.ProfilePrefKeys

// Reduced motion (WP16 critic P1-4). One flag for the whole tree, provided in MainActivity:
// the active profile's `reduceMotion` pref (true/false) wins; anything else ("system", unset)
// follows Android's animator duration scale (Developer options / Accessibility "Remove animations").
// When set: no route transitions, no staged Home entrance, no backdrop crossfade or ambient motion,
// no shared poster morph, hero size snaps, card glow off.

/** True when animations should be skipped. */
val LocalReducedMotion = staticCompositionLocalOf { false }

/** `Settings.Global.ANIMATOR_DURATION_SCALE == 0` ("Remove animations" / animations off). */
fun systemReducedMotion(context: Context): Boolean =
    runCatching { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }.getOrDefault(false)

/** The profile's explicit choice: true/false, or null = follow the system. */
fun Profile.reduceMotionPref(): Boolean? = (prefs[ProfilePrefKeys.REDUCE_MOTION] as? JsonPrimitive)?.booleanOrNull

/** Effective value for [profile] given the system setting. */
fun reducedMotionFor(profile: Profile?, system: Boolean): Boolean = profile?.reduceMotionPref() ?: system
