package ro.mixai.mobile.profiles

/** Pure state of a fixed-length numeric PIN entry (unit-tested; UI in PinPad.kt). */
data class PinPadState(val digits: String = "", val length: Int = 4) {
    val isComplete: Boolean get() = digits.length == length

    /** Adds one digit; ignored when complete or `d` is not 0..9. */
    fun press(d: Int): PinPadState = if (isComplete || d !in 0..9) this else copy(digits = digits + d)

    fun backspace(): PinPadState = if (digits.isEmpty()) this else copy(digits = digits.dropLast(1))

    fun clear(): PinPadState = copy(digits = "")
}
