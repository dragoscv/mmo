//! MIDI transport abstraction.
//!
//! The engine is transport-agnostic: hosts feed bytes into [`crate::MappingEngine::on_midi`]
//! and send what [`crate::MappingEngine::feedback`] returns. [`MidiTransport`] standardises
//! port enumeration and connection so the Tauri app, tests and future native layers
//! (BLE via [`crate::ble`]) share one shape.
//!
//! * `midir` feature: [`midir_backend::MidirTransport`] (WinMM / WinRT on Windows, CoreMIDI on
//!   macOS / iOS, ALSA / JACK on Linux, AMidi on Android).
//! * [`MemoryTransport`]: in-process loopback for tests and headless hosts.

use std::sync::{Arc, Mutex};

/// Direction of a port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortDirection {
    Input,
    Output,
}

/// An enumerated port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortInfo {
    /// Stable backend id (midir `MidiInputPort::id()` etc.).
    pub id: String,
    pub name: String,
    pub direction: PortDirection,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TransportError {
    #[error("port not found: {0}")]
    PortNotFound(String),
    #[error("MIDI backend error: {0}")]
    Backend(String),
    #[error("send failed: {0}")]
    Send(String),
}

/// Callback for incoming bytes: `(timestamp_us, bytes)`.
pub type InputCallback = Box<dyn FnMut(u64, &[u8]) + Send + 'static>;

/// Open input connection; dropping it closes the port.
pub trait InputConnection: Send {
    fn close(self: Box<Self>);
}

/// Open output connection.
pub trait OutputConnection: Send {
    fn send(&mut self, bytes: &[u8]) -> Result<(), TransportError>;
    fn close(self: Box<Self>);
}

/// A MIDI backend.
pub trait MidiTransport {
    fn inputs(&self) -> Result<Vec<PortInfo>, TransportError>;
    fn outputs(&self) -> Result<Vec<PortInfo>, TransportError>;
    fn connect_input(
        &mut self,
        port_id: &str,
        callback: InputCallback,
    ) -> Result<Box<dyn InputConnection>, TransportError>;
    fn connect_output(
        &mut self,
        port_id: &str,
    ) -> Result<Box<dyn OutputConnection>, TransportError>;
}

// ---- in-memory loopback ---------------------------------------------------------------------

type Callbacks = Arc<Mutex<Vec<(String, Arc<Mutex<InputCallback>>)>>>;
type SentLog = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

/// Loopback transport: [`MemoryTransport::inject`] delivers bytes to connected inputs, and
/// everything sent to outputs is recorded in [`MemoryTransport::sent`].
#[derive(Clone, Default)]
pub struct MemoryTransport {
    ports: Vec<PortInfo>,
    callbacks: Callbacks,
    sent: SentLog,
}

impl std::fmt::Debug for MemoryTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MemoryTransport")
            .field("ports", &self.ports)
            .finish()
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl MemoryTransport {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a virtual device with one input and one output port named `name`.
    pub fn add_device(&mut self, name: &str) {
        for direction in [PortDirection::Input, PortDirection::Output] {
            self.ports.push(PortInfo {
                id: format!("mem:{name}"),
                name: name.to_string(),
                direction,
            });
        }
    }

    /// Deliver bytes as if the device `port_id` sent them.
    pub fn inject(&self, port_id: &str, timestamp_us: u64, bytes: &[u8]) {
        let cbs: Vec<_> = lock(&self.callbacks)
            .iter()
            .filter(|(id, _)| id == port_id)
            .map(|(_, cb)| cb.clone())
            .collect();
        for cb in cbs {
            let mut g = lock(&cb);
            (*g)(timestamp_us, bytes);
        }
    }

    pub fn sent(&self) -> Vec<(String, Vec<u8>)> {
        lock(&self.sent).clone()
    }

    fn find(&self, id: &str, dir: PortDirection) -> Result<(), TransportError> {
        self.ports
            .iter()
            .any(|p| p.id == id && p.direction == dir)
            .then_some(())
            .ok_or_else(|| TransportError::PortNotFound(id.to_string()))
    }
}

struct MemIn {
    id: String,
    callbacks: Callbacks,
}

impl InputConnection for MemIn {
    fn close(self: Box<Self>) {
        lock(&self.callbacks).retain(|(id, _)| *id != self.id);
    }
}

struct MemOut {
    id: String,
    sent: SentLog,
}

impl OutputConnection for MemOut {
    fn send(&mut self, bytes: &[u8]) -> Result<(), TransportError> {
        lock(&self.sent).push((self.id.clone(), bytes.to_vec()));
        Ok(())
    }
    fn close(self: Box<Self>) {}
}

impl MidiTransport for MemoryTransport {
    fn inputs(&self) -> Result<Vec<PortInfo>, TransportError> {
        Ok(self
            .ports
            .iter()
            .filter(|p| p.direction == PortDirection::Input)
            .cloned()
            .collect())
    }

    fn outputs(&self) -> Result<Vec<PortInfo>, TransportError> {
        Ok(self
            .ports
            .iter()
            .filter(|p| p.direction == PortDirection::Output)
            .cloned()
            .collect())
    }

    fn connect_input(
        &mut self,
        port_id: &str,
        callback: InputCallback,
    ) -> Result<Box<dyn InputConnection>, TransportError> {
        self.find(port_id, PortDirection::Input)?;
        lock(&self.callbacks).push((port_id.to_string(), Arc::new(Mutex::new(callback))));
        Ok(Box::new(MemIn {
            id: port_id.to_string(),
            callbacks: self.callbacks.clone(),
        }))
    }

    fn connect_output(
        &mut self,
        port_id: &str,
    ) -> Result<Box<dyn OutputConnection>, TransportError> {
        self.find(port_id, PortDirection::Output)?;
        Ok(Box::new(MemOut {
            id: port_id.to_string(),
            sent: self.sent.clone(),
        }))
    }
}

// ---- midir backend --------------------------------------------------------------------------

#[cfg(feature = "midir")]
pub mod midir_backend {
    //! [`MidirTransport`] over midir 0.11.

    use super::{
        InputCallback, InputConnection, MidiTransport, OutputConnection, PortDirection, PortInfo,
        TransportError,
    };
    use midir::{MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};

    /// midir-backed transport. `client_name` is shown by OS MIDI tools.
    pub struct MidirTransport {
        client_name: String,
    }

    impl MidirTransport {
        pub fn new(client_name: &str) -> Self {
            Self {
                client_name: client_name.to_string(),
            }
        }

        fn input(&self) -> Result<MidiInput, TransportError> {
            let mut i = MidiInput::new(&self.client_name)
                .map_err(|e| TransportError::Backend(e.to_string()))?;
            // We want clock and SysEx (identity replies); only filter active sensing.
            i.ignore(midir::Ignore::ActiveSense);
            Ok(i)
        }

        fn output(&self) -> Result<MidiOutput, TransportError> {
            MidiOutput::new(&self.client_name).map_err(|e| TransportError::Backend(e.to_string()))
        }
    }

    struct In(MidiInputConnection<()>);
    impl InputConnection for In {
        fn close(self: Box<Self>) {
            let _ = self.0.close();
        }
    }

    struct Out(MidiOutputConnection);
    impl OutputConnection for Out {
        fn send(&mut self, bytes: &[u8]) -> Result<(), TransportError> {
            self.0
                .send(bytes)
                .map_err(|e| TransportError::Send(e.to_string()))
        }
        fn close(self: Box<Self>) {
            let _ = self.0.close();
        }
    }

    impl MidiTransport for MidirTransport {
        fn inputs(&self) -> Result<Vec<PortInfo>, TransportError> {
            let i = self.input()?;
            Ok(i.ports()
                .iter()
                .map(|p| PortInfo {
                    id: p.id(),
                    name: i.port_name(p).unwrap_or_default(),
                    direction: PortDirection::Input,
                })
                .collect())
        }

        fn outputs(&self) -> Result<Vec<PortInfo>, TransportError> {
            let o = self.output()?;
            Ok(o.ports()
                .iter()
                .map(|p| PortInfo {
                    id: p.id(),
                    name: o.port_name(p).unwrap_or_default(),
                    direction: PortDirection::Output,
                })
                .collect())
        }

        fn connect_input(
            &mut self,
            port_id: &str,
            mut callback: InputCallback,
        ) -> Result<Box<dyn InputConnection>, TransportError> {
            let i = self.input()?;
            let port = i
                .find_port_by_id(port_id)
                .ok_or_else(|| TransportError::PortNotFound(port_id.to_string()))?;
            let conn = i
                .connect(
                    &port,
                    "decks-mapping-in",
                    move |ts, bytes, _| callback(ts, bytes),
                    (),
                )
                .map_err(|e| TransportError::Backend(e.to_string()))?;
            Ok(Box::new(In(conn)))
        }

        fn connect_output(
            &mut self,
            port_id: &str,
        ) -> Result<Box<dyn OutputConnection>, TransportError> {
            let o = self.output()?;
            let port = o
                .find_port_by_id(port_id)
                .ok_or_else(|| TransportError::PortNotFound(port_id.to_string()))?;
            let conn = o
                .connect(&port, "decks-mapping-out")
                .map_err(|e| TransportError::Backend(e.to_string()))?;
            Ok(Box::new(Out(conn)))
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// Enumeration must not panic even on CI machines without MIDI devices.
        #[test]
        fn enumerates_without_panicking() {
            let t = MidirTransport::new("decks-mapping-test");
            let _ = t.inputs();
            let _ = t.outputs();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_transport_loopback() {
        let mut t = MemoryTransport::new();
        t.add_device("DDJ-FLX4");
        assert_eq!(t.inputs().unwrap().len(), 1);
        let got = Arc::new(Mutex::new(Vec::new()));
        let g = got.clone();
        let conn = t
            .connect_input(
                "mem:DDJ-FLX4",
                Box::new(move |ts, b| lock(&g).push((ts, b.to_vec()))),
            )
            .unwrap();
        t.inject("mem:DDJ-FLX4", 42, &[0x90, 0x0B, 0x7F]);
        assert_eq!(*lock(&got), vec![(42, vec![0x90, 0x0B, 0x7F])]);
        conn.close();
        t.inject("mem:DDJ-FLX4", 43, &[0x90, 0x0B, 0x00]);
        assert_eq!(lock(&got).len(), 1);
        let mut out = t.connect_output("mem:DDJ-FLX4").unwrap();
        out.send(&[0x9F, 0x00, 0x7F]).unwrap();
        assert_eq!(t.sent().len(), 1);
        assert!(t.connect_output("mem:nope").is_err());
    }
}
