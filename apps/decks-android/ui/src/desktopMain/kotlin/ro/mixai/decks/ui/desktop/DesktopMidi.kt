package ro.mixai.decks.ui.desktop

import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.sound.midi.MidiDevice
import javax.sound.midi.MidiMessage
import javax.sound.midi.MidiSystem
import javax.sound.midi.Receiver
import javax.swing.SwingUtilities
import ro.mixai.decks.ui.DecksController

/**
 * MIDI controllers on Windows / Linux through `javax.sound.midi`: every input device (a device
 * with transmitters) is opened and its bytes go to `DecksMapping.on_midi` on the UI thread
 * (AWT EDT = Compose Desktop main thread). javax.sound.midi has no hot-plug events, so the device
 * list is re-read every 3 s.
 */
class DesktopMidi(private val ctl: DecksController) : AutoCloseable {
    private val open = mutableMapOf<String, MidiDevice>()
    private val poller = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "decks-midi").apply { isDaemon = true } }

    fun start() {
        poller.scheduleWithFixedDelay(::refresh, 0, 3, TimeUnit.SECONDS)
    }

    private fun refresh() {
        val infos = runCatching { MidiSystem.getMidiDeviceInfo().toList() }.getOrDefault(emptyList())
        val present = mutableSetOf<String>()
        for (info in infos) {
            val dev = runCatching { MidiSystem.getMidiDevice(info) }.getOrNull() ?: continue
            if (dev.maxTransmitters == 0 || dev is javax.sound.midi.Sequencer || dev is javax.sound.midi.Synthesizer) continue
            val key = "${info.name}|${info.vendor}|${info.description}"
            present += key
            if (open.containsKey(key)) continue
            try {
                dev.open()
                val name = info.name
                dev.transmitter.receiver = object : Receiver {
                    override fun send(message: MidiMessage, timeStamp: Long) {
                        val bytes = message.message.copyOf(message.length)
                        val ts = if (timeStamp >= 0) timeStamp else System.nanoTime() / 1000
                        SwingUtilities.invokeLater { ctl.onMidiBytes(name, bytes, ts) }
                    }
                    override fun close() = Unit
                }
                open[key] = dev
                SwingUtilities.invokeLater { ctl.backend.detectMapping(name, null, null); updateStatus() }
            } catch (_: Throwable) {
                runCatching { dev.close() }
            }
        }
        val gone = open.keys - present
        gone.forEach { k -> open.remove(k)?.let { runCatching { it.close() } } }
        if (gone.isNotEmpty()) SwingUtilities.invokeLater(::updateStatus)
    }

    private fun updateStatus() {
        val names = open.keys.map { it.substringBefore('|') }
        ctl.midiStatus = if (names.isEmpty()) null else "${names.joinToString()} · ${ctl.backend.mappingName()}"
    }

    override fun close() {
        poller.shutdownNow()
        open.values.forEach { runCatching { it.close() } }
        open.clear()
    }
}
