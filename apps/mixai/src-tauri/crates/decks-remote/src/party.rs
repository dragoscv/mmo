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

fn clean(s: &str) -> Result<String, PartyError> {
    let t: String = s
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
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
}
