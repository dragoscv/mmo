//! File tag reading via lofty (MIT OR Apache-2.0).

use std::path::Path;

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::tag::{Accessor, ItemKey};

use crate::keys::MusicalKey;
use crate::model::TrackRecord;
use crate::{Error, Result};

/// Reads tags + audio properties of one file into a [`TrackRecord`] (no cues/grid).
pub fn read_file(path: &Path) -> Result<TrackRecord> {
    let tagged = lofty::read_from_path(path).map_err(|e| Error::Format(e.to_string()))?;
    let props = tagged.properties();
    let mut rec = TrackRecord {
        path: crate::util::path_to_string(path),
        duration_sec: Some(props.duration().as_secs_f64()).filter(|d| *d > 0.0),
        bitrate: props.audio_bitrate(),
        sample_rate: props.sample_rate(),
        ..TrackRecord::default()
    };
    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        rec.title = tag.title().map(|s| s.into_owned());
        rec.artist = tag.artist().map(|s| s.into_owned());
        rec.album = tag.album().map(|s| s.into_owned());
        rec.genre = tag.genre().map(|s| s.into_owned());
        rec.comment = tag.comment().map(|s| s.into_owned());
        rec.year = tag.date().map(|d| i32::from(d.year));
        rec.label = tag.get_string(ItemKey::Label).map(str::to_owned);
        rec.isrc = tag.get_string(ItemKey::Isrc).map(str::to_owned);
        rec.bpm = tag
            .get_string(ItemKey::Bpm)
            .or_else(|| tag.get_string(ItemKey::IntegerBpm))
            .and_then(|s| s.trim().replace(',', ".").parse::<f64>().ok())
            .filter(|b| *b > 0.0);
        rec.key = tag
            .get_string(ItemKey::InitialKey)
            .and_then(MusicalKey::parse);
    }
    if rec.title.is_none() {
        rec.title = path.file_stem().map(|s| s.to_string_lossy().into_owned());
    }
    Ok(rec)
}
