//! Neutral, lossless JSON exchange format (`mixai-decks-library`, version 1).

use serde::{Deserialize, Serialize};

use crate::model::Collection;
use crate::{Error, Result};

pub const FORMAT: &str = "mixai-decks-library";
pub const VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct Envelope {
    format: String,
    version: u32,
    collection: Collection,
}

pub fn to_json(col: &Collection) -> Result<String> {
    Ok(serde_json::to_string_pretty(&Envelope {
        format: FORMAT.into(),
        version: VERSION,
        collection: col.clone(),
    })?)
}

pub fn parse(s: &str) -> Result<Collection> {
    let env: Envelope = serde_json::from_str(s)?;
    if env.format != FORMAT {
        return Err(Error::Format(format!("unexpected format {:?}", env.format)));
    }
    if env.version > VERSION {
        return Err(Error::Format(format!(
            "unsupported version {}",
            env.version
        )));
    }
    Ok(env.collection)
}
