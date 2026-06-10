//! Master recording: capture the post-fader stereo mix to a WAV file.
//!
//! Real-time safe by design: the audio callback only pushes finished blocks of
//! interleaved stereo `f32` into a bounded channel (no file I/O, no locks). A
//! dedicated writer thread drains the channel and writes to disk with `hound`.
//! If the channel ever backs up (disk stall) the RT thread drops the block
//! rather than block — a glitch in the recording is preferable to an audio
//! dropout on the master output.

use std::path::PathBuf;
use std::thread::JoinHandle;

use crossbeam_channel::{bounded, Receiver, Sender};
use hound::{SampleFormat, WavSpec, WavWriter};

/// One block of interleaved stereo samples handed from the RT thread.
pub type RecBlock = Vec<f32>;

/// Control messages to the writer thread.
enum Ctl {
    Start { path: PathBuf, sample_rate: u32 },
    Stop,
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
            Recorder { audio_tx: audio_tx.clone(), ctl_tx, handle: Some(handle), active: false },
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

    /// Stop and finalize the current file.
    pub fn stop(&mut self) {
        let _ = self.ctl_tx.send(Ctl::Stop);
        self.active = false;
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

fn writer_loop(audio_rx: Receiver<RecBlock>, ctl_rx: Receiver<Ctl>) {
    let mut writer: Option<WavWriter<std::io::BufWriter<std::fs::File>>> = None;

    loop {
        crossbeam_channel::select! {
            recv(ctl_rx) -> msg => match msg {
                Ok(Ctl::Start { path, sample_rate }) => {
                    // Finalize any prior file first.
                    if let Some(w) = writer.take() {
                        let _ = w.finalize();
                    }
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
                Ok(Ctl::Stop) => {
                    if let Some(w) = writer.take() {
                        let _ = w.finalize();
                        log::info!("MIXAI recording stopped");
                    }
                }
                Ok(Ctl::Quit) | Err(_) => {
                    if let Some(w) = writer.take() {
                        let _ = w.finalize();
                    }
                    break;
                }
            },
            recv(audio_rx) -> block => match block {
                Ok(samples) => {
                    if let Some(w) = writer.as_mut() {
                        for s in samples {
                            let _ = w.write_sample(s);
                        }
                    }
                    // else: not recording → discard.
                }
                Err(_) => break,
            },
        }
    }
}
