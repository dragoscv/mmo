//! Presets (an effect chain), songs with parts, setlists. JSON format v1 — see docs/live/presets.md.

use live_dsp::chain::MAX_INSERTS;
use live_dsp::param::param_index;
use live_dsp::{Chain, FxKind, Insert};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const FORMAT_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InsertSpec {
    /// Effect id (`FxKind::id`), e.g. `"compressor"`.
    pub fx: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Parameter id → value. Missing ids keep their defaults; unknown ids are reported.
    #[serde(default)]
    pub params: BTreeMap<String, f32>,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Preset {
    #[serde(default = "format_v")]
    pub version: u32,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub chain: Vec<InsertSpec>,
}

fn format_v() -> u32 {
    FORMAT_VERSION
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum PresetError {
    #[error("unsupported preset format version {0}")]
    Version(u32),
    #[error("unknown effect `{0}`")]
    UnknownFx(String),
    #[error("too many inserts ({0} > {MAX_INSERTS})")]
    TooMany(usize),
    #[error("invalid JSON: {0}")]
    Json(String),
}

/// Built chain plus non-fatal issues (unknown parameter ids).
pub struct Built {
    pub chain: Box<Chain>,
    pub warnings: Vec<String>,
}

impl Preset {
    pub fn from_json(s: &str) -> Result<Self, PresetError> {
        let p: Preset = serde_json::from_str(s).map_err(|e| PresetError::Json(e.to_string()))?;
        if p.version > FORMAT_VERSION {
            return Err(PresetError::Version(p.version));
        }
        Ok(p)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_default()
    }

    /// Instantiate the chain (allocates: control thread only). Insert ids start at `first_id`.
    pub fn build(
        &self,
        sample_rate: f32,
        max_block: usize,
        first_id: u32,
    ) -> Result<Built, PresetError> {
        if self.version > FORMAT_VERSION {
            return Err(PresetError::Version(self.version));
        }
        if self.chain.len() > MAX_INSERTS {
            return Err(PresetError::TooMany(self.chain.len()));
        }
        let mut chain = Box::<Chain>::default();
        let mut warnings = Vec::new();
        for (n, spec) in self.chain.iter().enumerate() {
            let kind =
                FxKind::from_id(&spec.fx).ok_or_else(|| PresetError::UnknownFx(spec.fx.clone()))?;
            let mut ins = Insert::new(first_id + n as u32, kind, sample_rate, max_block);
            for (id, v) in &spec.params {
                match param_index(ins.fx.specs(), id) {
                    Some(i) => ins.fx.set_param(i, *v),
                    None => warnings.push(format!("{}: unknown parameter `{id}`", spec.fx)),
                }
            }
            // Parameters set at build time must not ramp in from defaults.
            ins.fx.reset();
            if !spec.enabled {
                ins.set_enabled(false);
            }
            if chain.try_insert(n, Box::new(ins)).is_err() {
                return Err(PresetError::TooMany(self.chain.len()));
            }
        }
        Ok(Built { chain, warnings })
    }

    /// Snapshot a live chain back into a preset.
    pub fn capture(name: &str, chain: &Chain) -> Self {
        let chain = chain
            .inserts
            .iter()
            .map(|ins| InsertSpec {
                fx: ins.kind.id().to_string(),
                enabled: ins.enabled(),
                params: ins
                    .fx
                    .specs()
                    .iter()
                    .enumerate()
                    .map(|(i, s)| (s.id.to_string(), ins.fx.param(i)))
                    .collect(),
            })
            .collect();
        Self {
            version: FORMAT_VERSION,
            name: name.into(),
            description: String::new(),
            tags: vec![],
            chain,
        }
    }
}

/// A part of a song (verse, chorus...) pointing at a preset by name, with optional overrides.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SongPart {
    pub name: String,
    pub preset: String,
    /// Optional MIDI program / foot-switch number that recalls this part.
    #[serde(default)]
    pub program: Option<u8>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Song {
    pub title: String,
    #[serde(default)]
    pub artist: String,
    /// Key as `"A minor"` / `"F# major"`: applied to autotune + harmonizer on recall.
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub bpm: Option<f32>,
    pub parts: Vec<SongPart>,
    #[serde(default)]
    pub lyrics: Option<String>,
    #[serde(default)]
    pub notes: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Setlist {
    #[serde(default = "format_v")]
    pub version: u32,
    pub name: String,
    pub songs: Vec<Song>,
}

/// Parse `"A minor"`, `"F#"`, `"Bb major"`, `"c# min"` into (key index, scale index).
pub fn parse_key(s: &str) -> Option<(usize, usize)> {
    let s = s.trim();
    let mut chars = s.chars();
    let letter = chars.next()?.to_ascii_uppercase();
    let base = match letter {
        'C' => 0,
        'D' => 2,
        'E' => 4,
        'F' => 5,
        'G' => 7,
        'A' => 9,
        'B' => 11,
        _ => return None,
    };
    let rest: String = chars.collect();
    let rest = rest.trim_start();
    let (acc, rest) = if let Some(r) = rest.strip_prefix('#') {
        (1i32, r)
    } else if let Some(r) = rest.strip_prefix('b') {
        (-1, r)
    } else {
        (0, rest)
    };
    let key = (base + acc).rem_euclid(12) as usize;
    let mode = rest.trim().to_ascii_lowercase();
    let scale = if mode.starts_with("min") || mode == "m" {
        2
    } else {
        1
    };
    Some((key, scale))
}

/// Factory presets shipped with the app (names are stable ids for setlists).
pub fn factory() -> Vec<Preset> {
    fn p(name: &str, description: &str, tags: &[&str], chain: &[(&str, &[(&str, f32)])]) -> Preset {
        Preset {
            version: FORMAT_VERSION,
            name: name.into(),
            description: description.into(),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            chain: chain
                .iter()
                .map(|(fx, params)| InsertSpec {
                    fx: fx.to_string(),
                    enabled: true,
                    params: params.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
                })
                .collect(),
        }
    }
    vec![
        p(
            "Natural Vocal",
            "Transparent live vocal: gentle gate, EQ, de-ess, compression, small room.",
            &["natural", "live"],
            &[
                (
                    "gate",
                    &[("threshold", -55.0), ("range", -20.0), ("ratio", 2.0)],
                ),
                (
                    "eq",
                    &[
                        ("hpf_freq", 90.0),
                        ("mid1_freq", 350.0),
                        ("mid1_gain", -2.0),
                        ("high_gain", 2.0),
                    ],
                ),
                ("deesser", &[("threshold", -32.0)]),
                (
                    "compressor",
                    &[
                        ("threshold", -20.0),
                        ("ratio", 3.0),
                        ("attack", 8.0),
                        ("release", 120.0),
                    ],
                ),
                ("reverb", &[("decay", 1.2), ("mix", 0.12)]),
                ("limiter", &[("ceiling", -1.0)]),
            ],
        ),
        p(
            "Pop Polish",
            "Modern pop: soft tuning, presence, doubler and tempo delay.",
            &["pop", "tune"],
            &[
                (
                    "eq",
                    &[
                        ("hpf_freq", 100.0),
                        ("mid2_freq", 3500.0),
                        ("mid2_gain", 3.0),
                        ("high_gain", 3.0),
                    ],
                ),
                ("deesser", &[("threshold", -30.0)]),
                (
                    "compressor",
                    &[("threshold", -22.0), ("ratio", 4.0), ("attack", 5.0)],
                ),
                (
                    "autotune",
                    &[("retune", 60.0), ("humanize", 0.5), ("amount", 0.7)],
                ),
                ("doubler", &[("mix", 0.25)]),
                ("delay", &[("sync", 6.0), ("mix", 0.15), ("feedback", 0.3)]),
                ("reverb", &[("decay", 1.8), ("mix", 0.15)]),
                ("limiter", &[]),
            ],
        ),
        p(
            "Hard Tune",
            "Robotic hard snap pitch correction (set key/scale per song).",
            &["tune", "fx"],
            &[
                ("eq", &[("hpf_freq", 110.0)]),
                ("compressor", &[("threshold", -24.0), ("ratio", 5.0)]),
                (
                    "autotune",
                    &[
                        ("retune", 0.5),
                        ("humanize", 0.0),
                        ("amount", 1.0),
                        ("formant", 1.0),
                    ],
                ),
                ("delay", &[("sync", 5.0), ("mix", 0.12)]),
                ("reverb", &[("decay", 1.5), ("mix", 0.12)]),
                ("limiter", &[]),
            ],
        ),
        p(
            "Harmony Stack",
            "Lead plus diatonic third above and fourth below.",
            &["harmony"],
            &[
                ("eq", &[("hpf_freq", 100.0)]),
                ("compressor", &[("threshold", -20.0), ("ratio", 3.0)]),
                ("autotune", &[("retune", 40.0), ("amount", 0.8)]),
                (
                    "harmonizer",
                    &[
                        ("v1_interval", 2.0),
                        ("v1_level", 0.45),
                        ("v2_interval", -3.0),
                        ("v2_level", 0.4),
                    ],
                ),
                ("reverb", &[("decay", 2.2), ("mix", 0.18)]),
                ("limiter", &[]),
            ],
        ),
        p(
            "Rock Grit",
            "Aggressive mids, tape saturation, slap delay.",
            &["rock"],
            &[
                ("gate", &[("threshold", -45.0)]),
                (
                    "eq",
                    &[
                        ("hpf_freq", 120.0),
                        ("mid1_freq", 1200.0),
                        ("mid1_gain", 3.0),
                    ],
                ),
                (
                    "compressor",
                    &[("threshold", -26.0), ("ratio", 6.0), ("attack", 2.0)],
                ),
                ("saturator", &[("drive", 14.0), ("mix", 0.6)]),
                (
                    "delay",
                    &[
                        ("time", 110.0),
                        ("feedback", 0.15),
                        ("mix", 0.18),
                        ("ping_pong", 0.0),
                    ],
                ),
                ("limiter", &[]),
            ],
        ),
        p(
            "Ballad Hall",
            "Warm and wide: chorus shimmer and long hall.",
            &["ballad"],
            &[
                (
                    "eq",
                    &[("hpf_freq", 80.0), ("low_gain", 1.5), ("high_gain", 2.0)],
                ),
                ("deesser", &[]),
                (
                    "compressor",
                    &[("threshold", -20.0), ("ratio", 2.5), ("release", 250.0)],
                ),
                ("chorus", &[("mix", 0.15), ("rate", 0.4)]),
                ("delay", &[("sync", 3.0), ("mix", 0.12), ("feedback", 0.4)]),
                (
                    "reverb",
                    &[("decay", 4.0), ("mix", 0.25), ("pre_delay", 40.0)],
                ),
                ("limiter", &[]),
            ],
        ),
        p(
            "Speech / MC",
            "Announcements and talkback: tight gate, clarity, no reverb.",
            &["speech"],
            &[
                ("gate", &[("threshold", -48.0), ("ratio", 10.0)]),
                (
                    "eq",
                    &[
                        ("hpf_freq", 120.0),
                        ("mid2_freq", 2500.0),
                        ("mid2_gain", 2.0),
                    ],
                ),
                ("deesser", &[]),
                (
                    "compressor",
                    &[("threshold", -24.0), ("ratio", 4.0), ("auto_makeup", 1.0)],
                ),
                ("limiter", &[]),
            ],
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_factory_preset_builds_without_warnings() {
        for p in factory() {
            let b = p
                .build(48000.0, 512, 1)
                .unwrap_or_else(|e| panic!("{}: {e}", p.name));
            assert!(b.warnings.is_empty(), "{}: {:?}", p.name, b.warnings);
            let back = Preset::from_json(&p.to_json()).unwrap();
            assert_eq!(back, p);
        }
    }

    #[test]
    fn capture_roundtrips_values() {
        let p = &factory()[0];
        let b = p.build(48000.0, 512, 1).unwrap();
        let cap = Preset::capture("x", &b.chain);
        assert_eq!(cap.chain.len(), p.chain.len());
        assert_eq!(cap.chain[0].params["threshold"], -55.0);
    }

    #[test]
    fn unknown_fx_and_params() {
        let mut p = factory()[0].clone();
        p.chain[0].params.insert("nope".into(), 1.0);
        assert_eq!(p.build(48000.0, 64, 1).unwrap().warnings.len(), 1);
        p.chain[0].fx = "flanger9000".into();
        assert!(matches!(
            p.build(48000.0, 64, 1),
            Err(PresetError::UnknownFx(_))
        ));
        assert!(matches!(
            Preset::from_json(r#"{"version":99,"name":"x","chain":[]}"#),
            Err(PresetError::Version(99))
        ));
    }

    #[test]
    fn keys_parse() {
        assert_eq!(parse_key("A minor"), Some((9, 2)));
        assert_eq!(parse_key("F# major"), Some((6, 1)));
        assert_eq!(parse_key("Bb"), Some((10, 1)));
        assert_eq!(parse_key("c# min"), Some((1, 2)));
        assert_eq!(parse_key("H"), None);
    }
}
