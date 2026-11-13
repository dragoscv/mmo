//! The stream overlay page (`/now`) served on loopback without the app: to look at it in a
//! browser, to try it in OBS before a set, or to script it.
//!
//! ```text
//! cargo run -p decks-remote --example now_demo -- [port] [overlay code]
//! ```
//!
//! Prints the address of the page WITH ITS CODE to standard output (that is what you paste
//! into a browser or into OBS; it is a throw-away code of this demo server, but do not run
//! the example where its output is logged or shared), then reads commands from standard
//! input, one per line, and answers each with one line:
//!
//! * `air <title>` or `air <title><TAB><artist>`: put a track on air
//! * `clear`: nothing on air
//! * `rotate`: a new overlay code (prints the new address, again with its code; the old one
//!   is refused)
//! * `clients`: how many overlays are connected
//! * `quit` (or end of input): stop
//!
//! It listens on 127.0.0.1 only. Port 0 or none = any free port; a code that does not have the
//! form of a code is replaced by a fresh one.

use std::io::BufRead;
use std::net::{IpAddr, Ipv4Addr};

use decks_remote::{OnAirTrack, RemoteConfig, RemoteServer};

fn text(s: &str) -> Option<String> {
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_string())
}

fn main() -> std::io::Result<()> {
    let mut args = std::env::args().skip(1);
    let port = args.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let code = args.next();
    let host = IpAddr::V4(Ipv4Addr::LOCALHOST);
    let server = RemoteServer::start_with_overlay(
        RemoteConfig {
            bind: host,
            port,
            party_open: false,
        },
        code,
    )?;
    println!("{}", server.overlay_url(host));
    let mut tracks = 0u32;
    for line in std::io::stdin().lock().lines() {
        let line = line?;
        let (command, rest) = line.split_once(' ').unwrap_or((line.as_str(), ""));
        match command.trim() {
            "air" => {
                let (title, artist) = rest.split_once('\t').unwrap_or((rest, ""));
                tracks += 1;
                server.publish_on_air(Some(OnAirTrack {
                    id: tracks.to_string(),
                    title: text(title),
                    artist: text(artist),
                }));
                println!("on air");
            }
            "clear" => {
                server.publish_on_air(None);
                println!("cleared");
            }
            "rotate" => {
                server.rotate_overlay_token();
                println!("{}", server.overlay_url(host));
            }
            "clients" => println!("{}", server.clients().iter().filter(|c| c.overlay).count()),
            "quit" => break,
            "" => {}
            other => println!("unknown command: {other}"),
        }
    }
    Ok(())
}
