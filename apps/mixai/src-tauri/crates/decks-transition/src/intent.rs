//! Voice / typed DJ intents in Romanian and English. A small deterministic parser covers the
//! common phrases offline; [`LLM_INTENT_SCHEMA`] lets the app ask codai (structured output) for
//! anything the parser does not recognise, and [`parse_llm_intent`] validates that answer.

use serde::{Deserialize, Serialize};

use crate::plan::Style;
use crate::rank::EnergyDirection;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntentAction {
    /// Plan + run a transition to the next track.
    MixNext,
    /// Suggest next tracks.
    Suggest,
    /// Cancel the running transition.
    Cancel,
    /// Play / pause / sync a deck.
    Play,
    Pause,
    Sync,
    /// Loop N beats on a deck.
    Loop,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Intent {
    pub action: IntentAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bars: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<Style>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub energy: Option<EnergyDirection>,
    /// 0-based deck.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deck: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub beats: Option<f64>,
}

impl Intent {
    fn new(action: IntentAction) -> Self {
        Self {
            action,
            bars: None,
            style: None,
            energy: None,
            deck: None,
            beats: None,
        }
    }

    fn validate(mut self) -> Option<Self> {
        if let Some(b) = self.bars {
            if !(1..=64).contains(&b) {
                return None;
            }
        }
        if let Some(d) = self.deck {
            if d > 3 {
                return None;
            }
        }
        if let Some(b) = self.beats {
            if !b.is_finite() || !(1.0 / 32.0..=64.0).contains(&b) {
                return None;
            }
        }
        if self.action != IntentAction::MixNext {
            self.style = None;
            self.bars = None;
        }
        Some(self)
    }
}

/// JSON Schema (draft 2020-12) for codai structured output; same shape as [`Intent`].
pub const LLM_INTENT_SCHEMA: &str = r#"{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "DecksIntent",
  "type": "object",
  "additionalProperties": false,
  "required": ["action"],
  "properties": {
    "action": { "enum": ["mix_next", "suggest", "cancel", "play", "pause", "sync", "loop"] },
    "bars": { "type": "integer", "minimum": 1, "maximum": 64 },
    "style": { "enum": ["bass_swap", "filter_sweep", "echo_out", "stem_swap", "cut"] },
    "energy": { "enum": ["hold", "up", "down"] },
    "deck": { "type": "integer", "minimum": 0, "maximum": 3 },
    "beats": { "type": "number", "minimum": 0.03125, "maximum": 64 }
  }
}"#;

/// Validate an LLM answer against the same rules as the local parser.
pub fn parse_llm_intent(json: &str) -> Option<Intent> {
    serde_json::from_str::<Intent>(json).ok()?.validate()
}

fn fold(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| match c {
            'ă' | 'â' | 'á' | 'à' => 'a',
            'î' | 'í' => 'i',
            'ș' | 'ş' => 's',
            'ț' | 'ţ' => 't',
            'é' | 'è' => 'e',
            c if c.is_alphanumeric() => c,
            _ => ' ',
        })
        .collect()
}

fn words_num(w: &str) -> Option<u32> {
    Some(match w {
        "one" | "unu" | "una" | "o" => 1,
        "two" | "doua" | "doi" => 2,
        "four" | "patru" => 4,
        "eight" | "opt" => 8,
        "sixteen" | "saisprezece" => 16,
        "thirty" | "treizeci" => 30,
        "thirtytwo" | "treizecisidoua" => 32,
        _ => w.parse().ok()?,
    })
}

fn has(t: &[&str], any: &[&str]) -> bool {
    t.iter().any(|w| any.contains(w))
}

fn contains(s: &str, any: &[&str]) -> bool {
    any.iter().any(|p| s.contains(p))
}

/// Number right before a unit word (`16 bars`, `32 de masuri`, `4 beats`, `8 batai`).
fn number_before(t: &[&str], units: &[&str]) -> Option<u32> {
    for (i, w) in t.iter().enumerate() {
        if units.contains(w) {
            let mut j = i;
            while j > 0 {
                j -= 1;
                if t[j] == "de" {
                    continue;
                }
                return words_num(t[j]);
            }
        }
    }
    None
}

fn deck_of(t: &[&str]) -> Option<u8> {
    for (i, w) in t.iter().enumerate() {
        if *w == "deck" || *w == "deckul" || *w == "pista" {
            if let Some(n) = t.get(i + 1) {
                return match *n {
                    "a" | "1" | "unu" | "one" => Some(0),
                    "b" | "2" | "doi" | "two" => Some(1),
                    "c" | "3" => Some(2),
                    "d" | "4" => Some(3),
                    _ => None,
                };
            }
        }
    }
    if t.contains(&"left") || t.contains(&"stanga") {
        return Some(0);
    }
    if t.contains(&"right") || t.contains(&"dreapta") {
        return Some(1);
    }
    None
}

/// Parse a RO / EN command. `None` = not understood (ask codai with [`LLM_INTENT_SCHEMA`]).
pub fn parse_intent(text: &str) -> Option<Intent> {
    let f = fold(text);
    let t: Vec<&str> = f.split_whitespace().collect();
    if t.is_empty() {
        return None;
    }
    let style = if contains(&f, &["bass swap", "schimb de bas", "schimba basul", "bass"]) {
        Some(Style::BassSwap)
    } else if contains(&f, &["filter", "filtru"]) {
        Some(Style::FilterSweep)
    } else if contains(&f, &["echo", "ecou"]) {
        Some(Style::EchoOut)
    } else if contains(&f, &["stem", "acapella", "vocal"]) {
        Some(Style::StemSwap)
    } else if contains(&f, &["cut", "taie", "brusc"]) {
        Some(Style::Cut)
    } else {
        None
    };
    let energy = if contains(
        &f,
        &[
            "more energy",
            "harder",
            "up the energy",
            "mai multa energie",
            "creste energia",
            "mai tare",
        ],
    ) {
        Some(EnergyDirection::Up)
    } else if contains(
        &f,
        &[
            "cool down",
            "calm",
            "less energy",
            "mai lent",
            "mai putina energie",
            "relax",
        ],
    ) {
        Some(EnergyDirection::Down)
    } else {
        None
    };
    let bars = number_before(&t, &["bars", "bar", "masuri", "masura"]);
    let beats = number_before(&t, &["beats", "beat", "batai", "timpi"]).map(f64::from);

    let action = if has(&t, &["cancel", "abort", "anuleaza", "opreste"])
        && contains(&f, &["transition", "mix", "tranzit"])
    {
        IntentAction::Cancel
    } else if has(
        &t,
        &["suggest", "recommend", "sugereaza", "recomanda", "propune"],
    ) || contains(&f, &["what next", "ce urmeaza", "ce pun"])
    {
        IntentAction::Suggest
    } else if contains(
        &f,
        &[
            "mix",
            "mixeaza",
            "transition",
            "tranzitie",
            "tranzitia",
            "next track",
            "piesa urmatoare",
            "urmatoarea",
        ],
    ) {
        IntentAction::MixNext
    } else if has(&t, &["loop", "bucla"]) {
        IntentAction::Loop
    } else if has(&t, &["sync", "sincronizeaza"]) {
        IntentAction::Sync
    } else if has(&t, &["pause", "stop", "pauza", "opreste"]) {
        IntentAction::Pause
    } else if has(&t, &["play", "start", "porneste", "canta"]) {
        IntentAction::Play
    } else {
        return None;
    };
    let mut i = Intent::new(action);
    i.style = style;
    i.energy = energy;
    i.bars = bars;
    i.deck = deck_of(&t);
    if action == IntentAction::Loop {
        i.beats = beats.or(bars.map(|b| f64::from(b) * 4.0)).or(Some(4.0));
        i.bars = None;
    }
    i.validate()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn english_mix_commands() {
        let i = parse_intent("Mix the next track in 16 bars with a bass swap").unwrap();
        assert_eq!(i.action, IntentAction::MixNext);
        assert_eq!(i.bars, Some(16));
        assert_eq!(i.style, Some(Style::BassSwap));
        let i = parse_intent("echo out into the next track, 8 bars").unwrap();
        assert_eq!(
            (i.action, i.style, i.bars),
            (IntentAction::MixNext, Some(Style::EchoOut), Some(8))
        );
    }

    #[test]
    fn romanian_with_and_without_diacritics() {
        let i = parse_intent("Fă tranziția în 32 de măsuri cu ecou").unwrap();
        assert_eq!(
            (i.action, i.bars, i.style),
            (IntentAction::MixNext, Some(32), Some(Style::EchoOut))
        );
        let i = parse_intent("fa tranzitia in 32 de masuri cu ecou").unwrap();
        assert_eq!(i.bars, Some(32));
        let i = parse_intent("Ce urmează? Vreau mai multă energie").unwrap();
        assert_eq!(
            (i.action, i.energy),
            (IntentAction::Suggest, Some(EnergyDirection::Up))
        );
        let i = parse_intent("pune o buclă de 8 bătăi pe deck B").unwrap();
        assert_eq!(
            (i.action, i.beats, i.deck),
            (IntentAction::Loop, Some(8.0), Some(1))
        );
        let i = parse_intent("anulează tranziția").unwrap();
        assert_eq!(i.action, IntentAction::Cancel);
    }

    #[test]
    fn deck_transport_and_defaults() {
        let i = parse_intent("sync deck a").unwrap();
        assert_eq!((i.action, i.deck), (IntentAction::Sync, Some(0)));
        let i = parse_intent("loop the right deck").unwrap();
        assert_eq!((i.beats, i.deck), (Some(4.0), Some(1)));
        assert_eq!(parse_intent("play").unwrap().action, IntentAction::Play);
    }

    #[test]
    fn nonsense_and_out_of_range_are_rejected() {
        assert_eq!(parse_intent("what's the weather"), None);
        assert_eq!(parse_intent(""), None);
        assert_eq!(parse_intent("mix next in 200 bars"), None);
    }

    #[test]
    fn llm_answers_are_validated_like_local_ones() {
        let ok =
            parse_llm_intent(r#"{"action":"mix_next","bars":16,"style":"stem_swap"}"#).unwrap();
        assert_eq!(ok.style, Some(Style::StemSwap));
        assert_eq!(parse_llm_intent(r#"{"action":"mix_next","bars":0}"#), None);
        assert_eq!(parse_llm_intent(r#"{"action":"loop","deck":7}"#), None);
        assert_eq!(parse_llm_intent(r#"{"action":"self_destruct"}"#), None);
        let schema: serde_json::Value = serde_json::from_str(LLM_INTENT_SCHEMA).unwrap();
        assert_eq!(schema["required"][0], "action");
        // Non-mix actions drop transition fields.
        let p = parse_llm_intent(r#"{"action":"play","deck":1,"style":"cut","bars":4}"#).unwrap();
        assert_eq!((p.style, p.bars), (None, None));
    }
}
