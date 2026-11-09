package ro.mixai.keybpm.songid

import android.content.Context

/** Build without the (non-redistributable) ShazamKit AAR: Song ID is hidden. */
private object NoShazamEngine : SongIdEngine {
    override val available = false
    override suspend fun identify(pcm16: ByteArray, sampleRate: Int, entryAtMillis: Long?) = SongIdResult.Failed("unavailable")
    override suspend fun retry(stored: StoredSignature) = SongIdResult.Failed("unavailable")
}

@Suppress("UNUSED_PARAMETER")
fun createSongIdEngine(context: Context, tokenUrl: String): SongIdEngine = NoShazamEngine
