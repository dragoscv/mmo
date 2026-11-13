//! Master recording: capture the post-fader stereo mix to a WAV file.
//!
//! Real-time safe by design: the audio callback only pushes finished blocks of
//! interleaved stereo `f32` into a bounded channel (no file I/O, no locks). A
//! dedicated writer thread drains the channel and writes to disk with `hound`.
//! If the channel ever backs up (disk stall) the RT thread drops the block
//! rather than block — a glitch in the recording is preferable to an audio
//! dropout on the master output.
//!
//! Stopping waits: [`Recorder::stop`] returns only after the writer thread has written every
//! block that was already queued and finalised the file (hound fills in the two length fields
//! of the WAV header only then), or after [`STOP_WAIT`]. A caller that ends the process right
//! after `stop` therefore leaves a complete file. The wait is on the caller's thread; the audio
//! callback only ever `try_send`s blocks and never waits for anything here.

use std::path::PathBuf;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crossbeam_channel::{
    Receiver, RecvTimeoutError, SendTimeoutError, Sender, TryRecvError, bounded,
};
use hound::{SampleFormat, WavSpec, WavWriter};

/// One block of interleaved stereo samples handed from the RT thread.
pub type RecBlock = Vec<f32>;

/// Longest [`Recorder::stop`] waits for the writer thread. A healthy disk needs milliseconds;
/// this only bounds a stalled one.
pub const STOP_WAIT: Duration = Duration::from_secs(3);

/// How a [`Recorder::stop`] ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopOutcome {
    /// The file is complete on disk: every queued block written, the header lengths filled in.
    Finalized,
    /// No file was open (never started, or the file could not be created).
    Idle,
    /// The writer hit an error while finalising: the file may be short or unreadable.
    Failed,
    /// The writer did not answer within [`STOP_WAIT`] (a stalled disk). It still finalises when
    /// the disk lets it, and dropping the recorder joins it; a process that exits before that
    /// leaves a header without its lengths.
    TimedOut,
}

type Wav = WavWriter<std::io::BufWriter<std::fs::File>>;

/// Control messages to the writer thread.
enum Ctl {
    Start {
        path: PathBuf,
        sample_rate: u32,
    },
    /// Finalise the file and answer on `done` when it is complete.
    Stop {
        done: Sender<StopOutcome>,
    },
    Quit,
}

/// UI-side handle owning the writer thread + channels.
pub struct Recorder {
    audio_tx: Sender<RecBlock>,
    ctl_tx: Sender<Ctl>,
    handle: Option<JoinHandle<()>>,
    active: bool,
}

impl Recorder {
    /// Spawn the writer thread. Returns the handle plus the audio sender that
    /// the RT mixer keeps to push blocks.
    pub fn spawn() -> (Self, Sender<RecBlock>) {
        // Generous buffer: ~64 blocks of audio absorb disk hiccups.
        let (audio_tx, audio_rx) = bounded::<RecBlock>(64);
        let (ctl_tx, ctl_rx) = bounded::<Ctl>(8);

        let handle = std::thread::Builder::new()
            .name("mixai-rec".into())
            .spawn(move || writer_loop(audio_rx, ctl_rx))
            .expect("spawn recorder thread");

        (
            Recorder {
                audio_tx: audio_tx.clone(),
                ctl_tx,
                handle: Some(handle),
                active: false,
            },
            audio_tx,
        )
    }

    pub fn is_recording(&self) -> bool {
        self.active
    }

    /// Begin writing to `path`. The RT mixer must then start pushing blocks.
    pub fn start(&mut self, path: PathBuf, sample_rate: u32) {
        let _ = self.ctl_tx.send(Ctl::Start { path, sample_rate });
        self.active = true;
    }

    /// Stop and finalize the current file, waiting (at most [`STOP_WAIT`]) until the writer
    /// has written every block that was already queued and finalised the file. Same as
    /// [`Recorder::stop_with_outcome`] for callers that do not need the answer.
    pub fn stop(&mut self) {
        let _ = self.stop_with_outcome();
    }

    /// Stop and finalize the current file; says how it ended. Blocks the calling thread for
    /// at most [`STOP_WAIT`]. Never called from the audio callback.
    pub fn stop_with_outcome(&mut self) -> StopOutcome {
        self.active = false;
        let (done_tx, done_rx) = bounded::<StopOutcome>(1);
        // One deadline for the whole stop. The control queue is tiny (8): a full one means the
        // writer is stuck, which is reported the same way as an answer that never comes.
        let deadline = Instant::now() + STOP_WAIT;
        match self
            .ctl_tx
            .send_deadline(Ctl::Stop { done: done_tx }, deadline)
        {
            Ok(()) => {}
            Err(SendTimeoutError::Timeout(_)) => return StopOutcome::TimedOut,
            // The writer thread is gone: nothing is writing, nothing to wait for.
            Err(SendTimeoutError::Disconnected(_)) => return StopOutcome::Failed,
        }
        match done_rx.recv_deadline(deadline) {
            Ok(outcome) => outcome,
            Err(RecvTimeoutError::Timeout) => StopOutcome::TimedOut,
            Err(RecvTimeoutError::Disconnected) => StopOutcome::Failed,
        }
    }

    /// The audio sender clone for the RT mixer.
    pub fn audio_sender(&self) -> Sender<RecBlock> {
        self.audio_tx.clone()
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        let _ = self.ctl_tx.send(Ctl::Quit);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

/// Write every block that is already queued into the open file, then finalise it (the two
/// length fields of the header are written here). Without an open file the queued blocks are
/// discarded, as the writer loop does with blocks that arrive while nothing records.
fn drain_and_finalize(writer: &mut Option<Wav>, audio_rx: &Receiver<RecBlock>) -> StopOutcome {
    let Some(mut w) = writer.take() else {
        while audio_rx.try_recv().is_ok() {}
        return StopOutcome::Idle;
    };
    let mut ok = true;
    while let Ok(samples) = audio_rx.try_recv() {
        for s in samples {
            if w.write_sample(s).is_err() {
                ok = false;
            }
        }
    }
    match w.finalize() {
        Ok(()) if ok => StopOutcome::Finalized,
        _ => StopOutcome::Failed,
    }
}

fn writer_loop(audio_rx: Receiver<RecBlock>, ctl_rx: Receiver<Ctl>) {
    let mut writer: Option<Wav> = None;

    /// What the loop takes next.
    enum Next {
        /// A control message (`None` = the recorder handle is gone).
        Ctl(Option<Ctl>),
        /// A block of audio (`None` = every sender is gone).
        Audio(Option<RecBlock>),
    }

    loop {
        // Control first: a Start opens the file before the blocks queued behind it are looked
        // at (a `select!` over both picks at random when both are ready, and a block taken
        // before its Start would be thrown away as "not recording").
        let next = match ctl_rx.try_recv() {
            Ok(msg) => Next::Ctl(Some(msg)),
            Err(TryRecvError::Disconnected) => Next::Ctl(None),
            Err(TryRecvError::Empty) => crossbeam_channel::select! {
                recv(ctl_rx) -> msg => Next::Ctl(msg.ok()),
                recv(audio_rx) -> block => Next::Audio(block.ok()),
            },
        };
        match next {
            Next::Ctl(Some(Ctl::Start { path, sample_rate })) => {
                // Finalize any prior file first (with the blocks queued for it).
                drain_and_finalize(&mut writer, &audio_rx);
                let spec = WavSpec {
                    channels: 2,
                    sample_rate,
                    bits_per_sample: 32,
                    sample_format: SampleFormat::Float,
                };
                match WavWriter::create(&path, spec) {
                    Ok(w) => {
                        log::info!("MIXAI recording → {}", path.display());
                        writer = Some(w);
                    }
                    Err(e) => log::error!("recorder: create {} failed: {e}", path.display()),
                }
            }
            Next::Ctl(Some(Ctl::Stop { done })) => {
                let outcome = drain_and_finalize(&mut writer, &audio_rx);
                if outcome != StopOutcome::Idle {
                    log::info!("MIXAI recording stopped ({outcome:?})");
                }
                // The caller may have given up waiting (STOP_WAIT): then nobody listens.
                let _ = done.try_send(outcome);
            }
            Next::Ctl(Some(Ctl::Quit)) | Next::Ctl(None) | Next::Audio(None) => {
                drain_and_finalize(&mut writer, &audio_rx);
                break;
            }
            Next::Audio(Some(samples)) => {
                if let Some(w) = writer.as_mut() {
                    for s in samples {
                        let _ = w.write_sample(s);
                    }
                }
                // else: not recording → discard.
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `(data_bytes, riff_bytes)` from the header of a classic WAV: the two fields hound fills
    /// in only at `finalize` (they are 0 while the file is being written).
    fn wav_lengths(path: &std::path::Path) -> (u32, u32) {
        let bytes = std::fs::read(path).expect("read wav");
        assert!(bytes.len() >= 44, "header too short: {} bytes", bytes.len());
        assert_eq!(&bytes[0..4], b"RIFF");
        let riff = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
        // The "data" chunk follows "fmt " (16 bytes of body) and, for float, a "fact" chunk.
        let mut i = 12;
        while i + 8 <= bytes.len() {
            let id = &bytes[i..i + 4];
            let len = u32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]]);
            if id == b"data" {
                return (len, riff);
            }
            i += 8 + len as usize + (len as usize & 1);
        }
        panic!("no data chunk in {}", path.display());
    }

    fn temp_wav(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("mixai-rec-test-{}-{tag}.wav", std::process::id()))
    }

    /// Wait until the writer thread has created the file. The engine does the same by
    /// construction: it switches the audio tap on after `start`, and the first block comes one
    /// audio callback later. (A block that reaches the writer before its Start is "not
    /// recording" and is discarded.)
    fn wait_open(path: &std::path::Path) {
        let t = Instant::now();
        while !path.exists() {
            assert!(
                t.elapsed() < Duration::from_secs(10),
                "the writer never opened {}",
                path.display()
            );
            std::thread::yield_now();
        }
    }

    #[test]
    fn stop_returns_only_when_the_header_holds_the_bytes_written() {
        let path = temp_wav("lengths");
        let _ = std::fs::remove_file(&path);
        let (mut rec, audio_tx) = Recorder::spawn();
        rec.start(path.clone(), 48_000);
        assert!(rec.is_recording());
        wait_open(&path);
        // 40 blocks of 2048 samples, the way the mixer pushes them (the channel holds 64).
        const BLOCKS: usize = 40;
        const SAMPLES: usize = 2048;
        for b in 0..BLOCKS {
            let block: RecBlock = (0..SAMPLES)
                .map(|i| (b * SAMPLES + i) as f32 * 1e-6)
                .collect();
            audio_tx.send(block).expect("queue a block");
        }
        // No sleep: stop must wait for the writer itself.
        let outcome = rec.stop_with_outcome();
        assert!(!rec.is_recording());
        assert_eq!(outcome, StopOutcome::Finalized);
        // Read AT ONCE: the header lengths equal the data written.
        let (data, riff) = wav_lengths(&path);
        let want = (BLOCKS * SAMPLES * 4) as u32;
        assert_eq!(data, want, "data chunk length");
        assert_eq!(
            riff,
            std::fs::metadata(&path).unwrap().len() as u32 - 8,
            "RIFF length"
        );
        // And the samples are the ones that were queued, in order.
        let mut r = hound::WavReader::open(&path).expect("open wav");
        assert_eq!(r.spec().sample_rate, 48_000);
        assert_eq!(r.spec().channels, 2);
        let samples: Vec<f32> = r.samples::<f32>().map(|s| s.unwrap()).collect();
        assert_eq!(samples.len(), BLOCKS * SAMPLES);
        assert_eq!(samples[SAMPLES + 1], (SAMPLES + 1) as f32 * 1e-6);
        drop(rec);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn stopping_without_a_file_is_idle_and_quick() {
        let (mut rec, _tx) = Recorder::spawn();
        let t = Instant::now();
        assert_eq!(rec.stop_with_outcome(), StopOutcome::Idle);
        assert!(t.elapsed() < Duration::from_secs(1));
        // A file that cannot be created: start is accepted, stop says idle (nothing written).
        let nowhere = std::env::temp_dir()
            .join("mixai-rec-test-no-such-dir-7f3a")
            .join("x.wav");
        rec.start(nowhere, 48_000);
        assert_eq!(rec.stop_with_outcome(), StopOutcome::Idle);
        assert!(!rec.is_recording());
    }

    #[test]
    fn a_second_start_finalizes_the_first_file_with_its_queued_blocks() {
        let a = temp_wav("first");
        let b = temp_wav("second");
        let _ = std::fs::remove_file(&a);
        let _ = std::fs::remove_file(&b);
        let (mut rec, audio_tx) = Recorder::spawn();
        rec.start(a.clone(), 44_100);
        wait_open(&a);
        audio_tx.send(vec![0.5f32; 512]).unwrap();
        // The block is in the queue before the second Start is: whichever the writer takes
        // first, the block belongs to the first file.
        rec.start(b.clone(), 44_100);
        assert_eq!(rec.stop_with_outcome(), StopOutcome::Finalized);
        assert_eq!(wav_lengths(&a).0, 512 * 4);
        assert_eq!(
            wav_lengths(&b).0,
            0,
            "the second file is complete and empty"
        );
        drop(rec);
        let _ = std::fs::remove_file(&a);
        let _ = std::fs::remove_file(&b);
    }

    #[test]
    fn the_wait_is_bounded() {
        assert!(STOP_WAIT >= Duration::from_secs(1) && STOP_WAIT <= Duration::from_secs(10));
    }

    /// Without a thread, so nothing depends on timing: blocks that are still in the queue when
    /// the stop is handled belong to the file.
    #[test]
    fn blocks_still_queued_at_the_stop_are_written_before_the_header_is_closed() {
        let path = temp_wav("drain");
        let spec = WavSpec {
            channels: 2,
            sample_rate: 48_000,
            bits_per_sample: 32,
            sample_format: SampleFormat::Float,
        };
        let mut writer = Some(WavWriter::create(&path, spec).expect("create"));
        let (tx, rx) = bounded::<RecBlock>(8);
        for _ in 0..3 {
            tx.send(vec![0.125f32; 1000]).unwrap();
        }
        assert_eq!(drain_and_finalize(&mut writer, &rx), StopOutcome::Finalized);
        assert!(writer.is_none(), "the file is closed");
        assert!(rx.is_empty(), "the queue was drained");
        assert_eq!(wav_lengths(&path).0, 3 * 1000 * 4);
        // Nothing open: queued blocks are dropped and the answer is Idle.
        tx.send(vec![0.0f32; 10]).unwrap();
        assert_eq!(drain_and_finalize(&mut writer, &rx), StopOutcome::Idle);
        assert!(rx.is_empty());
        let _ = std::fs::remove_file(&path);
    }
}
