package ro.mixai.decks.ui.platform

import android.content.Context
import android.media.midi.MidiDevice
import android.media.midi.MidiDeviceInfo
import android.media.midi.MidiManager
import android.media.midi.MidiOutputPort
import android.media.midi.MidiReceiver
import android.os.Handler
import android.os.Looper
import android.util.Log
import ro.mixai.decks.ui.DecksController

/**
 * USB and Bluetooth LE MIDI controllers through `android.media.midi`: every device with an output
 * port is opened, its bytes go to `DecksMapping.on_midi` (via [DecksController.onMidiBytes]) on the
 * main thread; hot-plug via a device callback. BLE devices appear once the system has paired /
 * opened them (MIDI+BTLE settings or a BLE MIDI app); in-app BLE scanning is not part of the MVP.
 */
class AndroidMidi(context: Context, private val ctl: DecksController) : AutoCloseable {
    private val manager = context.getSystemService(Context.MIDI_SERVICE) as? MidiManager
    private val main = Handler(Looper.getMainLooper())
    private val open = mutableMapOf<Int, Pair<MidiDevice, MidiOutputPort>>()

    private val callback = object : MidiManager.DeviceCallback() {
        override fun onDeviceAdded(device: MidiDeviceInfo) = openDevice(device)
        override fun onDeviceRemoved(device: MidiDeviceInfo) {
            open.remove(device.id)?.let { (d, p) -> runCatching { p.close(); d.close() } }
            updateStatus()
        }
    }

    fun start() {
        val m = manager ?: run { ctl.midiStatus = null; return }
        @Suppress("DEPRECATION")
        m.devices.forEach(::openDevice)
        m.registerDeviceCallback(callback, main)
        updateStatus()
    }

    private fun openDevice(info: MidiDeviceInfo) {
        val m = manager ?: return
        if (info.outputPortCount == 0 || open.containsKey(info.id)) return
        val name = info.properties.getString(MidiDeviceInfo.PROPERTY_NAME) ?: "MIDI ${info.id}"
        m.openDevice(info, { device ->
            if (device == null) return@openDevice
            val port = device.openOutputPort(0) ?: run { device.close(); return@openDevice }
            val usb = info.properties.getParcelable<android.hardware.usb.UsbDevice>(MidiDeviceInfo.PROPERTY_USB_DEVICE)
            ctl.backend.detectMapping(name, usb?.vendorId, usb?.productId)
            port.connect(object : MidiReceiver() {
                override fun onSend(msg: ByteArray, offset: Int, count: Int, timestamp: Long) {
                    val bytes = msg.copyOfRange(offset, offset + count)
                    main.post { ctl.onMidiBytes(name, bytes, timestamp / 1000) }
                }
            })
            open[info.id] = device to port
            Log.i("DecksMidi", "opened $name (${info.type})")
            updateStatus()
        }, main)
    }

    private fun updateStatus() {
        val names = open.values.map { it.first.info.properties.getString(MidiDeviceInfo.PROPERTY_NAME) ?: "?" }
        ctl.midiStatus = if (names.isEmpty()) null else "${names.joinToString()} · ${ctl.backend.mappingName()}"
    }

    override fun close() {
        runCatching { manager?.unregisterDeviceCallback(callback) }
        open.values.forEach { (d, p) -> runCatching { p.close(); d.close() } }
        open.clear()
    }
}
