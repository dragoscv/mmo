//! `mixai-music://` links (WP17-45 canonical set, shared with Android `MusicNavigator` and iOS `MusicDeepLink`) mapped
//! to INTERNAL web routes. Internal `/media/music/...` paths work on every host: on music.mixai.ro `proxy.ts` 308s them
//! to the clean URL, on localhost/run.app they render as-is.
//!
//!   mixai-music://album/<id>              -> /media/music/album/<id>
//!   mixai-music://artist/<id>             -> /media/music/artist/<id>
//!   mixai-music://now-playing | nowplaying -> /media/music/now-playing
//!   mixai-music://search[?q=..]           -> /media/music/search[?q=..]
//!   mixai-music://downloads               -> /media/downloads
//!   mixai-music://mix                     -> /media/music?mix=1
//!   mixai-music://play?ids=a,b&index=n    -> /media/music?play=a,b&index=n
//!   mixai-music://play?q=..               -> /media/music/search?q=..&play=1   (blank q = mix)
//!   mixai-music:// (no host)              -> /media/music

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use url::Url;

pub const SCHEME: &str = "mixai-music";
const ID_SAFE: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.');

fn enc(s: &str) -> String {
    utf8_percent_encode(s, ID_SAFE).to_string()
}

fn query(url: &Url, key: &str) -> Option<String> {
    url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.trim().to_string())
}

/// Internal web path for a `mixai-music://` link, or `None` when the link is not ours / malformed.
pub fn web_path(link: &str) -> Option<String> {
    let url = Url::parse(link.trim()).ok()?;
    if url.scheme() != SCHEME {
        return None;
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    // Path segments arrive percent-encoded: decode, then re-encode as one opaque segment.
    let seg: Vec<String> = url
        .path_segments()
        .map(|s| s.filter(|p| !p.is_empty()).map(|p| percent_decode_str(p).decode_utf8_lossy().into_owned()).collect())
        .unwrap_or_default();
    let id = seg.first().map(String::as_str).filter(|s| !s.is_empty());
    match host.as_str() {
        "" => Some("/media/music".into()),
        "album" => id.map(|i| format!("/media/music/album/{}", enc(i))),
        "artist" => id.map(|i| format!("/media/music/artist/{}", enc(i))),
        "now-playing" | "nowplaying" => Some("/media/music/now-playing".into()),
        "search" => match query(&url, "q").filter(|q| !q.is_empty()) {
            Some(q) => Some(format!("/media/music/search?q={}", enc(&q))),
            None => Some("/media/music/search".into()),
        },
        "downloads" => Some("/media/downloads".into()),
        "mix" => Some("/media/music?mix=1".into()),
        "play" => {
            let ids: Vec<String> = query(&url, "ids")
                .unwrap_or_default()
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if !ids.is_empty() {
                let index = query(&url, "index").and_then(|s| s.parse::<usize>().ok()).unwrap_or(0).min(ids.len() - 1);
                let list: Vec<String> = ids.iter().map(|i| enc(i)).collect();
                return Some(format!("/media/music?play={}&index={index}", list.join(",")));
            }
            match query(&url, "q").filter(|q| !q.is_empty()) {
                Some(q) => Some(format!("/media/music/search?q={}&play=1", enc(&q))),
                None => Some("/media/music?mix=1".into()),
            }
        }
        _ => None,
    }
}

/// First `mixai-music://` argument on a command line (Windows/Linux deliver links as argv to a new process).
pub fn from_args<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter().find(|a| a.starts_with("mixai-music:")).and_then(|a| web_path(&a))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_the_canonical_set() {
        assert_eq!(web_path("mixai-music://album/al_7").as_deref(), Some("/media/music/album/al_7"));
        assert_eq!(web_path("mixai-music://artist/ar%201").as_deref(), Some("/media/music/artist/ar%201"));
        assert_eq!(web_path("mixai-music://now-playing").as_deref(), Some("/media/music/now-playing"));
        assert_eq!(web_path("mixai-music://nowplaying").as_deref(), Some("/media/music/now-playing"));
        assert_eq!(web_path("mixai-music://search?q=Daft%20Punk").as_deref(), Some("/media/music/search?q=Daft%20Punk"));
        assert_eq!(web_path("mixai-music://search").as_deref(), Some("/media/music/search"));
        assert_eq!(web_path("mixai-music://downloads").as_deref(), Some("/media/downloads"));
        assert_eq!(web_path("mixai-music://mix").as_deref(), Some("/media/music?mix=1"));
        assert_eq!(web_path("mixai-music://").as_deref(), Some("/media/music"));
    }

    #[test]
    fn play_prefers_ids_and_clamps_the_index() {
        assert_eq!(web_path("mixai-music://play?ids=tr_1,tr_2&index=1").as_deref(), Some("/media/music?play=tr_1,tr_2&index=1"));
        assert_eq!(web_path("mixai-music://play?ids=tr_1,,tr_2&index=9&q=x").as_deref(), Some("/media/music?play=tr_1,tr_2&index=1"));
        assert_eq!(web_path("mixai-music://play?ids=tr_1&index=-3").as_deref(), Some("/media/music?play=tr_1&index=0"));
        assert_eq!(web_path("mixai-music://play?q=chill").as_deref(), Some("/media/music/search?q=chill&play=1"));
        assert_eq!(web_path("mixai-music://play?q=").as_deref(), Some("/media/music?mix=1"));
    }

    #[test]
    fn rejects_foreign_and_malformed_links() {
        assert_eq!(web_path("https://music.mixai.ro/album/1"), None);
        assert_eq!(web_path("mixai://title/movie/1"), None);
        assert_eq!(web_path("mixai-music://album"), None);
        assert_eq!(web_path("mixai-music://unknown/x"), None);
        assert_eq!(web_path("not a url"), None);
        // Path injection: ids are percent-encoded, never raw path segments.
        assert_eq!(web_path("mixai-music://album/..%2F..%2Fapi").as_deref(), Some("/media/music/album/..%2F..%2Fapi"));
    }

    #[test]
    fn finds_the_link_in_argv() {
        let args = vec!["C:\\MixAI Music.exe".to_string(), "mixai-music://album/9".to_string()];
        assert_eq!(from_args(args).as_deref(), Some("/media/music/album/9"));
        assert_eq!(from_args(vec!["app".to_string(), "--flag".to_string()]), None);
    }
}
