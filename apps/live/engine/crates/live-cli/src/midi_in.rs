//! Opens every MIDI input port (midir) and forwards raw messages to the control loop.
//! A port that refuses to open (in use by another app on WinMM) is skipped, not fatal.

use midir::{Ignore, MidiInput, MidiInputConnection};
use std::sync::mpsc::SyncSender;

const CLIENT: &str = "MixAI Live";

fn input() -> Option<MidiInput> {
    let mut i = MidiInput::new(CLIENT).ok()?;
    // Clock/sensing would flood the channel; sysex is not used.
    i.ignore(Ignore::All);
    Some(i)
}

pub fn port_names() -> Vec<String> {
    input()
        .map(|i| {
            i.ports()
                .iter()
                .filter_map(|p| i.port_name(p).ok())
                .collect()
        })
        .unwrap_or_default()
}

pub struct Inputs {
    conns: Vec<(String, MidiInputConnection<()>)>,
}

impl Inputs {
    pub fn names(&self) -> Vec<String> {
        self.conns.iter().map(|(n, _)| n.clone()).collect()
    }
}

/// Connect all inputs except our own virtual loopbacks. Messages that do not fit the channel
/// (control loop stalled) are dropped: MIDI control is best-effort and must never block the driver.
pub fn open_all(tx: SyncSender<Vec<u8>>) -> Inputs {
    let mut conns = Vec::new();
    let Some(probe) = input() else {
        return Inputs { conns };
    };
    for port in probe.ports() {
        let name = probe.port_name(&port).unwrap_or_default();
        if name.starts_with(CLIENT) {
            continue;
        }
        let Some(i) = input() else { continue };
        let tx = tx.clone();
        match i.connect(
            &port,
            "mixai-live-in",
            move |_ts, bytes, _| {
                let _ = tx.try_send(bytes.to_vec());
            },
            (),
        ) {
            Ok(c) => conns.push((name, c)),
            Err(e) => eprintln!("MIDI input `{name}` skipped: {e}"),
        }
    }
    Inputs { conns }
}
