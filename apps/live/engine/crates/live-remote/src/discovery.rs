//! mDNS announcement `_mixai-live._tcp.local.` so controllers find engines on the LAN.
//! Pairing still needs the token from the QR code; discovery only fills in host/port.

use mdns_sd::{ServiceDaemon, ServiceInfo};
use std::net::IpAddr;

pub const SERVICE: &str = "_mixai-live._tcp.local.";

pub struct Announcer {
    daemon: ServiceDaemon,
    fullname: String,
}

impl Announcer {
    pub fn start(name: &str, ip: IpAddr, port: u16, osc_port: Option<u16>) -> Result<Self, String> {
        let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
        let instance: String = name
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == ' ' || *c == '-')
            .take(40)
            .collect();
        let host = format!("mixai-live-{}.local.", port);
        let osc = osc_port.map(|p| p.to_string()).unwrap_or_default();
        let props = [("v", "1"), ("name", name), ("osc", osc.as_str())];
        let info = ServiceInfo::new(SERVICE, &instance, &host, ip, port, &props[..])
            .map_err(|e| e.to_string())?;
        let fullname = info.get_fullname().to_string();
        daemon.register(info).map_err(|e| e.to_string())?;
        Ok(Self { daemon, fullname })
    }
}

impl Drop for Announcer {
    fn drop(&mut self) {
        let _ = self.daemon.unregister(&self.fullname);
        let _ = self.daemon.shutdown();
    }
}
