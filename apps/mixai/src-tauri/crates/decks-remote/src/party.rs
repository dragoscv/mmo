//! Party DJ song requests: dedup by normalised title + artist, one vote per client, rate limit
//! per client, DJ moderation. Pure data structure (no I/O), driven by the server and the app.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

/// Longest accepted title / artist / note (chars, after trimming).
pub const MAX_FIELD: usize = 120;
/// Pending requests one client may have open at once.
pub const MAX_OPEN_PER_CLIENT: usize = 3;
/// Pending requests kept in total (oldest lowest-voted is dropped beyond this).
pub const MAX_PENDING: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestStatus {
    Pending,
    Accepted,
    Rejected,
    Played,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PartyError {
    Closed,
    Empty,
    TooLong,
    TooManyOpen,
    NotFound,
    NotPending,
    AlreadyVoted,
}

impl std::fmt::Display for PartyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            PartyError::Closed => "requests are closed",
            PartyError::Empty => "title is empty",
            PartyError::TooLong => "text is too long",
            PartyError::TooManyOpen => "too many open requests from this device",
            PartyError::NotFound => "request not found",
            PartyError::NotPending => "request is no longer pending",
            PartyError::AlreadyVoted => "already voted",
        })
    }
}

impl std::error::Error for PartyError {}

/// Full request as the DJ (controller / app) sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SongRequestView {
    pub id: u64,
    pub title: String,
    pub artist: String,
    pub note: String,
    pub votes: u32,
    pub status: RequestStatus,
    /// Client ids that asked for it (first one = author).
    pub clients: Vec<String>,
    /// Monotonic order of arrival.
    pub seq: u64,
}

/// What guests see: no notes, no client ids.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PublicRequest {
    pub id: u64,
    pub title: String,
    pub artist: String,
    pub votes: u32,
    pub status: RequestStatus,
    /// `true` when the viewing client already voted / asked for it.
    pub mine: bool,
    /// Moderation note, only filled for the controller.
    #[serde(skip_serializing_if = "String::is_empty", default)]
    pub note: String,
}

#[derive(Debug, Clone)]
struct Entry {
    view: SongRequestView,
    voters: HashSet<String>,
}

/// The request queue.
#[derive(Debug, Clone)]
pub struct RequestQueue {
    open: bool,
    next_id: u64,
    seq: u64,
    items: HashMap<u64, Entry>,
}

impl Default for RequestQueue {
    fn default() -> Self {
        Self {
            open: true,
            next_id: 1,
            seq: 0,
            items: HashMap::new(),
        }
    }
}

/// Characters that draw nothing or re-order their neighbours: controls, zero-width and
/// bidirectional formatting (overrides, embeddings, isolates, marks), tags and fillers. Text
/// from a guest made of them would show blank, reversed or spoofed in the DJ's list and on the
/// other phones, so they are removed before anything is stored or compared.
///
/// This is the classification of ONE character. [`strip_hidden`] looks at the neighbours too
/// and keeps three kinds of them where they do draw something: control white space (a line
/// break becomes a space), the zero width joiner inside an emoji sequence, and the tag
/// characters of a subdivision flag.
pub fn is_hidden_char(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{00AD}'                      // soft hyphen
                | '\u{034F}'                // combining grapheme joiner
                | '\u{061C}'                // Arabic letter mark
                | '\u{115F}' | '\u{1160}'   // Hangul fillers
                | '\u{17B4}' | '\u{17B5}'   // Khmer inherent vowels (never drawn)
                | '\u{180B}'..='\u{180F}'   // Mongolian free variation selectors, vowel separator
                | '\u{200B}'..='\u{200F}'   // zero width space and joiners, LRM, RLM
                | '\u{202A}'..='\u{202E}'   // bidi embeddings and overrides
                | '\u{2060}'..='\u{206F}'   // word joiner, invisible operators, bidi isolates
                | '\u{2800}'                // braille blank
                | '\u{3164}' | '\u{FFA0}'   // Hangul fillers
                | '\u{FEFF}'                // byte order mark / zero width no-break space
                | '\u{FFF9}'..='\u{FFFB}'   // interlinear annotation
                | '\u{1BCA0}'..='\u{1BCA3}' // shorthand format controls
                | '\u{1D173}'..='\u{1D17A}' // musical symbol format controls
                | '\u{E0000}'..='\u{E007F}' // tags
        )
}

/// Variation selectors change how the character before them is drawn (text or emoji style)
/// and draw nothing themselves.
fn is_variation_selector(c: char) -> bool {
    matches!(c, '\u{FE00}'..='\u{FE0F}' | '\u{E0100}'..='\u{E01EF}')
}

/// White space that is a control or a line break: tab, line feed, vertical tab, form feed,
/// carriage return, next line (U+0085), line and paragraph separator (U+2028, U+2029). A
/// reader sees a gap there, so it becomes a space instead of being removed with the controls.
fn is_line_space(c: char) -> bool {
    (c.is_control() && c.is_whitespace()) || matches!(c, '\u{2028}' | '\u{2029}')
}

/// Zero width joiner: glues emoji into one picture (family, profession, flags).
const ZWJ: char = '\u{200D}';
/// Black flag: with a tag sequence after it, a subdivision flag (England, Scotland, Wales).
const BLACK_FLAG: char = '\u{1F3F4}';
/// Ends a tag sequence.
const CANCEL_TAG: char = '\u{E007F}';
/// Longest tag sequence kept after a black flag, the cancel tag included (a subdivision code
/// is at most 6 letters and digits).
const MAX_FLAG_TAGS: usize = 8;

/// A letter or digit of the Latin script. A joiner next to one draws nothing.
fn is_latin_alnum(c: char) -> bool {
    c.is_ascii_alphanumeric()
        || (matches!(c, '\u{00AA}'..='\u{024F}' | '\u{1E00}'..='\u{1EFF}') && c.is_alphabetic())
}

/// Whether a zero width joiner may stand next to `c`: something a reader sees, and not a
/// Latin letter or digit.
fn joins(c: char) -> bool {
    !c.is_whitespace() && !is_hidden_char(c) && !is_variation_selector(c) && !is_latin_alnum(c)
}

/// Byte length of the tag sequence at the start of `rest` (the text right after a black flag):
/// 1 or more tag digits / lower-case tag letters, then the cancel tag, at most
/// [`MAX_FLAG_TAGS`] characters. None = no such sequence.
fn flag_tags(rest: &str) -> Option<usize> {
    let mut len = 0;
    for (n, c) in rest.chars().take(MAX_FLAG_TAGS).enumerate() {
        len += c.len_utf8();
        match c {
            CANCEL_TAG => return (n > 0).then_some(len),
            '\u{E0030}'..='\u{E0039}' | '\u{E0061}'..='\u{E007A}' => {}
            _ => return None,
        }
    }
    None
}

/// `s` as a reader sees it: without hidden characters ([`is_hidden_char`]) and without
/// variation selectors that have no visible character before them (after an emoji they stay:
/// they belong to it). A text made only of invisible characters comes back empty or as white
/// space.
///
/// Three kinds of hidden characters are kept or replaced, because they do show:
///
/// * Control white space and line breaks (tab, CR, LF, U+0085, U+2028, U+2029) become ONE
///   space ("a\nb" is "a b", not "ab"); none is added after other white space or at the start
///   (one can be left at the end: callers trim).
/// * A zero width joiner stays between two visible characters that are not Latin letters or
///   digits: an emoji sequence (family, profession with a skin tone, rainbow flag) stays one
///   picture. Between Latin letters, next to white space or at either end it draws nothing
///   and is removed.
/// * Tag characters stay only as the tag sequence of a subdivision flag: right after the
///   black flag U+1F3F4, tag digits and lower-case tag letters ended by the cancel tag
///   U+E007F, at most [`MAX_FLAG_TAGS`] of them. Anywhere else they are removed (they are
///   invisible text).
pub fn strip_hidden(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    // The last kept character can carry one variation selector.
    let mut base = false;
    // The last kept character, variation selectors aside (they belong to it).
    let mut prev: Option<char> = None;
    let mut i = 0;
    while let Some(c) = s[i..].chars().next() {
        i += c.len_utf8();
        if is_line_space(c) {
            if prev.is_some_and(|p| !p.is_whitespace()) {
                out.push(' ');
                prev = Some(' ');
            }
            base = false;
            continue;
        }
        if c == ZWJ {
            let next = s[i..].chars().next();
            if prev.is_some_and(joins) && next.is_some_and(joins) {
                out.push(c);
                prev = Some(c);
                base = false;
            }
            continue;
        }
        if is_hidden_char(c) {
            continue;
        }
        if is_variation_selector(c) {
            if base {
                out.push(c);
            }
            base = false;
            continue;
        }
        base = !c.is_whitespace();
        out.push(c);
        prev = Some(c);
        let tags = if c == BLACK_FLAG {
            flag_tags(&s[i..])
        } else {
            None
        };
        if let Some(len) = tags {
            out.push_str(&s[i..i + len]);
            i += len;
            base = false;
        }
    }
    out
}

/// Text as it is stored: hidden characters removed ([`strip_hidden`]), white space collapsed
/// to single spaces, trimmed. May be empty; too long is an error.
fn clean(s: &str) -> Result<String, PartyError> {
    let t: String = strip_hidden(s)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if t.chars().count() > MAX_FIELD {
        return Err(PartyError::TooLong);
    }
    Ok(t)
}

/// Dedup key: lower case, alphanumerics only, "feat." tails dropped.
pub(crate) fn norm_key(title: &str, artist: &str) -> String {
    let strip = |s: &str| {
        let lower = s.to_lowercase();
        let cut = ["(feat", "feat.", " ft.", " ft ", "(ft"]
            .iter()
            .filter_map(|m| lower.find(m))
            .min()
            .unwrap_or(lower.len());
        lower[..cut]
            .chars()
            .filter(|c| c.is_alphanumeric())
            .collect::<String>()
    };
    format!("{}|{}", strip(title), strip(artist))
}

impl RequestQueue {
    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn set_open(&mut self, open: bool) {
        self.open = open;
    }

    fn open_by(&self, client: &str) -> usize {
        self.items
            .values()
            .filter(|e| {
                e.view.status == RequestStatus::Pending
                    && e.view.clients.first().is_some_and(|c| c == client)
            })
            .count()
    }

    /// Add a request (or merge into the pending one with the same song, counting a vote).
    /// Returns `(id, merged)`.
    pub fn submit(
        &mut self,
        client: &str,
        title: &str,
        artist: &str,
        note: &str,
    ) -> Result<(u64, bool), PartyError> {
        if !self.open {
            return Err(PartyError::Closed);
        }
        let title = clean(title)?;
        let artist = clean(artist)?;
        let note = clean(note)?;
        if title.is_empty() {
            return Err(PartyError::Empty);
        }
        let key = norm_key(&title, &artist);
        if let Some(e) = self.items.values_mut().find(|e| {
            e.view.status == RequestStatus::Pending
                && norm_key(&e.view.title, &e.view.artist) == key
        }) {
            if e.voters.insert(client.to_string()) {
                e.view.votes += 1;
                e.view.clients.push(client.to_string());
            }
            return Ok((e.view.id, true));
        }
        if self.open_by(client) >= MAX_OPEN_PER_CLIENT {
            return Err(PartyError::TooManyOpen);
        }
        let id = self.next_id;
        self.next_id += 1;
        self.seq += 1;
        let mut voters = HashSet::new();
        voters.insert(client.to_string());
        self.items.insert(
            id,
            Entry {
                view: SongRequestView {
                    id,
                    title,
                    artist,
                    note,
                    votes: 1,
                    status: RequestStatus::Pending,
                    clients: vec![client.to_string()],
                    seq: self.seq,
                },
                voters,
            },
        );
        self.trim();
        Ok((id, false))
    }

    fn trim(&mut self) {
        while self
            .items
            .values()
            .filter(|e| e.view.status == RequestStatus::Pending)
            .count()
            > MAX_PENDING
        {
            let victim = self
                .items
                .values()
                .filter(|e| e.view.status == RequestStatus::Pending)
                .min_by_key(|e| (e.view.votes, e.view.seq))
                .map(|e| e.view.id);
            match victim {
                Some(id) => {
                    self.items.remove(&id);
                }
                None => break,
            }
        }
    }

    /// One vote per client per request, pending requests only.
    pub fn vote(&mut self, client: &str, id: u64) -> Result<u32, PartyError> {
        let e = self.items.get_mut(&id).ok_or(PartyError::NotFound)?;
        if e.view.status != RequestStatus::Pending {
            return Err(PartyError::NotPending);
        }
        if !e.voters.insert(client.to_string()) {
            return Err(PartyError::AlreadyVoted);
        }
        e.view.votes += 1;
        Ok(e.view.votes)
    }

    /// DJ decision.
    pub fn set_status(&mut self, id: u64, status: RequestStatus) -> Result<(), PartyError> {
        let e = self.items.get_mut(&id).ok_or(PartyError::NotFound)?;
        e.view.status = status;
        Ok(())
    }

    /// Drop finished (rejected / played) requests.
    pub fn clear_done(&mut self) {
        self.items.retain(|_, e| {
            matches!(
                e.view.status,
                RequestStatus::Pending | RequestStatus::Accepted
            )
        });
    }

    /// Ordered for display: accepted first, then pending by votes desc, then arrival; done last.
    pub fn list(&self) -> Vec<SongRequestView> {
        let mut v: Vec<_> = self.items.values().map(|e| e.view.clone()).collect();
        let rank = |s: RequestStatus| match s {
            RequestStatus::Accepted => 0,
            RequestStatus::Pending => 1,
            RequestStatus::Played => 2,
            RequestStatus::Rejected => 3,
        };
        v.sort_by(|a, b| {
            rank(a.status)
                .cmp(&rank(b.status))
                .then(b.votes.cmp(&a.votes))
                .then(a.seq.cmp(&b.seq))
        });
        v
    }

    /// The list as `client` may see it. Guests do not see rejected requests or notes.
    pub fn public_list(&self, client: &str, moderator: bool) -> Vec<PublicRequest> {
        self.list()
            .into_iter()
            .filter(|r| moderator || r.status != RequestStatus::Rejected)
            .map(|r| {
                let mine = self
                    .items
                    .get(&r.id)
                    .is_some_and(|e| e.voters.contains(client));
                PublicRequest {
                    id: r.id,
                    title: r.title,
                    artist: r.artist,
                    votes: r.votes,
                    status: r.status,
                    mine,
                    note: if moderator { r.note } else { String::new() },
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_songs_merge_and_count_as_votes() {
        let mut q = RequestQueue::default();
        let (a, merged) = q.submit("c1", "Strobe", "deadmau5", "").unwrap();
        assert!(!merged);
        let (b, merged) = q.submit("c2", "  strobe ", "Deadmau5", "pls").unwrap();
        assert!(merged);
        assert_eq!(a, b);
        assert_eq!(q.list()[0].votes, 2);
        // Same client asking again does not add a vote.
        q.submit("c2", "STROBE", "deadmau5", "").unwrap();
        assert_eq!(q.list()[0].votes, 2);
    }

    #[test]
    fn feat_tails_are_ignored_for_dedup() {
        assert_eq!(
            norm_key("Titanium (feat. Sia)", "David Guetta"),
            norm_key("Titanium", "David Guetta ft. Sia")
        );
    }

    #[test]
    fn one_vote_per_client_and_only_while_pending() {
        let mut q = RequestQueue::default();
        let (id, _) = q.submit("c1", "Song", "", "").unwrap();
        assert_eq!(q.vote("c1", id), Err(PartyError::AlreadyVoted));
        assert_eq!(q.vote("c2", id), Ok(2));
        q.set_status(id, RequestStatus::Played).unwrap();
        assert_eq!(q.vote("c3", id), Err(PartyError::NotPending));
        assert_eq!(q.vote("c3", 999), Err(PartyError::NotFound));
    }

    #[test]
    fn rate_limit_closed_empty_and_length() {
        let mut q = RequestQueue::default();
        for i in 0..MAX_OPEN_PER_CLIENT {
            q.submit("c1", &format!("Song {i}"), "", "").unwrap();
        }
        assert_eq!(
            q.submit("c1", "One more", "", ""),
            Err(PartyError::TooManyOpen)
        );
        assert_eq!(q.submit("c2", "   ", "", ""), Err(PartyError::Empty));
        assert_eq!(
            q.submit("c2", &"x".repeat(MAX_FIELD + 1), "", ""),
            Err(PartyError::TooLong)
        );
        q.set_open(false);
        assert_eq!(q.submit("c2", "Late", "", ""), Err(PartyError::Closed));
    }

    #[test]
    fn ordering_and_guest_view() {
        let mut q = RequestQueue::default();
        let (a, _) = q.submit("c1", "A", "", "note").unwrap();
        let (b, _) = q.submit("c2", "B", "", "").unwrap();
        let (c, _) = q.submit("c3", "C", "", "").unwrap();
        q.vote("c4", b).unwrap();
        q.set_status(c, RequestStatus::Accepted).unwrap();
        q.set_status(a, RequestStatus::Rejected).unwrap();
        let ids: Vec<_> = q.list().iter().map(|r| r.id).collect();
        assert_eq!(ids, vec![c, b, a]);
        let guest = q.public_list("c4", false);
        assert_eq!(guest.len(), 2, "guests do not see rejected requests");
        assert!(guest.iter().find(|r| r.id == b).unwrap().mine);
        assert!(guest.iter().all(|r| r.note.is_empty()));
        let dj = q.public_list("dj", true);
        assert_eq!(dj.iter().find(|r| r.id == a).unwrap().note, "note");
        q.clear_done();
        assert_eq!(q.list().len(), 2);
    }

    #[test]
    fn control_characters_are_stripped() {
        let mut q = RequestQueue::default();
        q.submit("c1", "Bad\u{0}\u{7}  Title\n", "", "").unwrap();
        assert_eq!(q.list()[0].title, "Bad Title");
    }

    /// England: black flag, the tags "gbeng", cancel tag.
    const ENGLAND: &str = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";

    #[test]
    fn line_breaks_become_one_space_and_other_controls_still_go() {
        // Romanian text is left exactly as typed.
        for keep in [
            "Ștefan Bănică",
            "ă â î ș ț Ă Â Î Ș Ț",
            "Înger și demon în țară",
            "Zdob și Zdub — Bună dimineața!",
        ] {
            assert_eq!(strip_hidden(keep), keep);
        }
        for (text, want) in [
            ("a\nb", "a b"),
            ("Line1\nLine2", "Line1 Line2"),
            ("a\r\nb", "a b"),
            ("a\tb", "a b"),
            ("a\u{B}\u{C}b", "a b"),
            ("a\u{85}b", "a b"),
            ("a\u{2028}b", "a b"),
            ("a\u{2029}\u{2028}\n\nb", "a b"),
            // No space is added where one already is, or where the text starts.
            ("a \nb", "a b"),
            ("a\n b", "a  b"),
            ("\n\ta", "a"),
            ("a\n", "a "),
            // Controls that are not white space are still removed without a gap.
            ("a\u{0}b", "ab"),
            ("a\u{7}\u{1B}b", "ab"),
            ("a\u{7F}b", "ab"),
            ("a\u{9F}b", "ab"),
            // A bidi override is still removed, next to a line break too.
            ("\u{202E}live", "live"),
            ("a\u{202E}\n\u{202C}b", "a b"),
            ("ș\u{200B}\nț", "ș ț"),
        ] {
            assert_eq!(strip_hidden(text), want, "{text:?}");
        }
        // Through the queue: two lines are two words, in every field.
        let mut q = RequestQueue::default();
        q.submit("c1", "Line1\nLine2", "Zdob\r\nși\tZdub", "pls\u{2028}now")
            .unwrap();
        let r = &q.list()[0];
        assert_eq!(
            (r.title.as_str(), r.artist.as_str(), r.note.as_str()),
            ("Line1 Line2", "Zdob și Zdub", "pls now")
        );
        // Nothing but line breaks is still an empty title.
        assert_eq!(
            q.submit("c1", "\n\t\r\u{2028}", "", ""),
            Err(PartyError::Empty)
        );
    }

    #[test]
    fn emoji_sequences_and_subdivision_flags_stay_whole() {
        let unchanged = [
            // Family: man, woman, girl.
            "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}".to_string(),
            // Profession with a skin tone: woman, medium skin tone, rocket.
            "\u{1F469}\u{1F3FD}\u{200D}\u{1F680}".to_string(),
            // Rainbow flag: white flag, emoji style, rainbow.
            "\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}".to_string(),
            // Heart on fire, pirate flag (black flag, joiner, skull and crossbones).
            "\u{2764}\u{FE0F}\u{200D}\u{1F525}".to_string(),
            "\u{1F3F4}\u{200D}\u{2620}\u{FE0F}".to_string(),
            ENGLAND.to_string(),
            format!("Party {ENGLAND} tonight {ENGLAND}"),
            // The longest tag sequence kept: 7 code characters and the cancel tag.
            format!("\u{1F3F4}{}\u{E007F}", "\u{E0061}".repeat(7)),
            // A joiner inside a word of a script that shapes with it.
            "\u{0D9A}\u{0DCA}\u{200D}\u{0DBA}".to_string(),
        ];
        for text in &unchanged {
            assert_eq!(&strip_hidden(text), text, "{text:?}");
        }
        let flag = "\u{1F3F4}";
        for (text, want) in [
            // A joiner that joins nothing a reader sees is removed.
            ("a\u{200D}b".to_string(), "ab"),
            ("ș\u{200D}ț".to_string(), "șț"),
            ("7\u{200D}7".to_string(), "77"),
            ("\u{1F3A7}\u{200D}".to_string(), "\u{1F3A7}"),
            ("\u{200D}\u{1F3A7}".to_string(), "\u{1F3A7}"),
            ("\u{1F3A7}\u{200D} x".to_string(), "\u{1F3A7} x"),
            (
                "\u{1F3A7} \u{200D}\u{1F3A7}".to_string(),
                "\u{1F3A7} \u{1F3A7}",
            ),
            ("\u{1F3A7}\u{200D}a".to_string(), "\u{1F3A7}a"),
            ("a\u{200D}\u{1F3A7}".to_string(), "a\u{1F3A7}"),
            (
                "\u{1F3A7}\u{200D}\n\u{1F3A7}".to_string(),
                "\u{1F3A7} \u{1F3A7}",
            ),
            // ... and never two in a row, or one next to another hidden character.
            (
                "\u{1F3A7}\u{200D}\u{200D}\u{1F3A7}".to_string(),
                "\u{1F3A7}\u{200D}\u{1F3A7}",
            ),
            (
                "\u{1F3A7}\u{200D}\u{200B}\u{1F3A7}".to_string(),
                "\u{1F3A7}\u{1F3A7}",
            ),
            (
                "\u{1F3A7}\u{200D}\u{202E}\u{1F3A7}".to_string(),
                "\u{1F3A7}\u{1F3A7}",
            ),
            // Tag characters are invisible text everywhere but in a complete flag sequence.
            ("x\u{E0067}\u{E0062}\u{E007F}".to_string(), "x"),
            (format!("{flag}\u{E0067}\u{E0062}"), flag),
            (format!("{flag}\u{E007F}"), flag),
            (format!("{flag}\u{E0041}\u{E007F}"), flag),
            (format!("{flag}\u{E0020}\u{E007F}"), flag),
            (format!("{flag}\u{E0067}x\u{E007F}"), "\u{1F3F4}x"),
            (format!("{flag}{}\u{E007F}", "\u{E0061}".repeat(8)), flag),
            (format!("{flag}{}", "\u{E0061}".repeat(500)), flag),
            (format!("{ENGLAND}\u{E0067}\u{E007F}"), ENGLAND),
        ] {
            assert_eq!(strip_hidden(&text), want, "{text:?}");
        }
        // Cleaning twice changes nothing more.
        for text in &unchanged {
            assert_eq!(strip_hidden(&strip_hidden(text)), strip_hidden(text));
        }
        // Through the queue: the flag is stored whole, and what only looks like text is not.
        let mut q = RequestQueue::default();
        q.submit("c1", &format!("Football {ENGLAND}"), "", "")
            .unwrap();
        assert_eq!(q.list()[0].title, format!("Football {ENGLAND}"));
        for blank in ["\u{200D}", "\u{E0067}\u{E007F}", "\u{200D}\n\u{200D}"] {
            assert_eq!(
                q.submit("c2", blank, "", ""),
                Err(PartyError::Empty),
                "{blank:?}"
            );
        }
    }

    #[test]
    fn bidi_and_zero_width_characters_are_stripped() {
        // Every code point a guest could use to reverse, hide or spoof a line.
        let hidden = [
            '\u{202A}',
            '\u{202B}',
            '\u{202C}',
            '\u{202D}',
            '\u{202E}',
            '\u{2066}',
            '\u{2067}',
            '\u{2068}',
            '\u{2069}',
            '\u{200B}',
            '\u{200C}',
            '\u{200D}',
            '\u{200E}',
            '\u{200F}',
            '\u{FEFF}',
            '\u{2060}',
            '\u{00AD}',
            '\u{061C}',
            '\u{E0041}',
        ];
        for c in hidden {
            assert!(is_hidden_char(c), "U+{:04X}", c as u32);
            let mut q = RequestQueue::default();
            q.submit(
                "c1",
                &format!("{c}Str{c}obe{c}"),
                &format!("dead{c}mau5"),
                &format!("{c}hi"),
            )
            .unwrap();
            let r = &q.list()[0];
            assert_eq!(
                (r.title.as_str(), r.artist.as_str(), r.note.as_str()),
                ("Strobe", "deadmau5", "hi"),
                "U+{:04X}",
                c as u32
            );
        }
        // What people really type stays: letters of any script, digits, emoji, punctuation.
        for c in ['a', 'ș', 'Ж', '中', 'ע', '7', '🎧', '\u{FE0F}', '\'', ' '] {
            assert!(!is_hidden_char(c), "U+{:04X}", c as u32);
        }
        // "evil" written backwards behind an override reads as typed, not as displayed.
        let mut q = RequestQueue::default();
        q.submit("c1", "\u{202E}live", "", "").unwrap();
        assert_eq!(q.list()[0].title, "live");
    }

    #[test]
    fn a_title_of_hidden_characters_only_is_empty() {
        let mut q = RequestQueue::default();
        for blank in [
            "\u{200B}",
            " \u{200B}\u{FEFF} ",
            "\u{202E}\u{202C}",
            "\u{2066}\u{2069}\u{200D}",
            "\u{3164}",
            "\u{2800} \u{00AD}",
            // Variation selectors with nothing to vary: nothing is drawn.
            "\u{FE0F}",
            "\u{FE0F}\u{FE0E} \u{E0100}",
            "\u{200B}\u{FE0F}",
        ] {
            assert_eq!(
                q.submit("c1", blank, "artist", ""),
                Err(PartyError::Empty),
                "{blank:?}"
            );
        }
        assert!(q.list().is_empty());
        // After a visible character a variation selector stays (emoji style), once.
        assert_eq!(
            strip_hidden("\u{2764}\u{FE0F} Love"),
            "\u{2764}\u{FE0F} Love"
        );
        assert_eq!(strip_hidden("\u{2764}\u{FE0F}\u{FE0F}"), "\u{2764}\u{FE0F}");
        assert_eq!(strip_hidden(" \u{FE0F}x"), " x");
        assert_eq!(strip_hidden("a\u{200B}\u{FE0F}b"), "a\u{FE0F}b");
        assert_eq!(strip_hidden("plain text"), "plain text");
        assert_eq!(strip_hidden(""), "");
        // Hidden characters do not count towards the length limit either.
        let padded = format!("{}{}", "\u{200B}".repeat(500), "x".repeat(MAX_FIELD));
        assert!(q.submit("c1", &padded, "", "").is_ok());
        // Two requests that differ only by hidden characters are the same song.
        let (a, _) = q.submit("c2", "Levels", "Avicii", "").unwrap();
        let (b, merged) = q
            .submit("c3", "Le\u{200B}vels", "Avi\u{202E}cii", "")
            .unwrap();
        assert!(merged);
        assert_eq!(a, b);
    }
}
