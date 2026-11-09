//! Smart crates: a JSON rule tree compiled to a parameterised SQL `WHERE` clause.
//!
//! ```json
//! {"all":[{"field":"bpm","op":"between","value":[120,128]},
//!         {"any":[{"field":"genre","op":"contains","value":"house"},
//!                 {"field":"camelot","op":"in","value":["8A","9A"]}]}]}
//! ```
//! Field names are mapped through a whitelist; values are always bound parameters.

use rusqlite::types::Value as SqlValue;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Error, Result};

/// Rule tree node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Rule {
    All { all: Vec<Rule> },
    Any { any: Vec<Rule> },
    Not { not: Box<Rule> },
    Cond(Condition),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Condition {
    pub field: String,
    pub op: Op,
    #[serde(default)]
    pub value: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    Eq,
    Ne,
    Lt,
    Lte,
    Gt,
    Gte,
    Between,
    Contains,
    StartsWith,
    In,
    IsNull,
    NotNull,
    /// `value` days before now (date fields).
    WithinDays,
    /// Harmonic match: same Camelot number ±1 or same number other mode (field `camelot`).
    Harmonic,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Text,
    Num,
    Date,
}

fn column(field: &str) -> Option<(&'static str, Kind)> {
    Some(match field {
        "title" => ("t.title", Kind::Text),
        "artist" => ("t.artist", Kind::Text),
        "album" => ("t.album", Kind::Text),
        "genre" => ("t.genre", Kind::Text),
        "label" => ("t.label", Kind::Text),
        "comment" => ("t.comment", Kind::Text),
        "isrc" => ("t.isrc", Kind::Text),
        "path" => ("t.path", Kind::Text),
        "camelot" => ("t.camelot", Kind::Text),
        "year" => ("t.year", Kind::Num),
        "duration" => ("t.duration_sec", Kind::Num),
        "bitrate" => ("t.bitrate", Kind::Num),
        "sample_rate" => ("t.sample_rate", Kind::Num),
        "bpm" => ("t.bpm", Kind::Num),
        "energy" => ("t.energy", Kind::Num),
        "rating" => ("t.rating", Kind::Num),
        "colour" => ("t.colour", Kind::Num),
        "lufs" => ("t.lufs", Kind::Num),
        "play_count" => ("t.play_count", Kind::Num),
        "key_pc" => ("t.key_pc", Kind::Num),
        "key_minor" => ("t.key_minor", Kind::Num),
        "added_at" => ("t.added_at", Kind::Date),
        "last_played" => ("t.last_played", Kind::Date),
        _ => return None,
    })
}

fn to_sql(v: &Value, kind: Kind) -> Result<SqlValue> {
    match (v, kind) {
        (Value::Null, _) => Ok(SqlValue::Null),
        (Value::Bool(b), _) => Ok(SqlValue::Integer(i64::from(*b))),
        (Value::Number(n), Kind::Text) => Ok(SqlValue::Text(n.to_string())),
        (Value::Number(n), _) => Ok(n
            .as_i64()
            .map(SqlValue::Integer)
            .or_else(|| n.as_f64().map(SqlValue::Real))
            .unwrap_or(SqlValue::Null)),
        (Value::String(s), Kind::Text) => Ok(SqlValue::Text(s.clone())),
        (Value::String(s), _) => s
            .parse::<f64>()
            .map(SqlValue::Real)
            .map_err(|_| Error::Rule(format!("expected a number, got {s:?}"))),
        _ => Err(Error::Rule(format!("unsupported value {v}"))),
    }
}

fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// Compiled clause + bound parameters.
pub struct Compiled {
    pub sql: String,
    pub params: Vec<SqlValue>,
}

/// Compiles a rule; `now` (unix seconds) anchors `within_days`.
pub fn compile(rule: &Rule, now: i64) -> Result<Compiled> {
    let mut params = Vec::new();
    let sql = compile_node(rule, now, &mut params)?;
    Ok(Compiled { sql, params })
}

fn compile_node(rule: &Rule, now: i64, p: &mut Vec<SqlValue>) -> Result<String> {
    match rule {
        Rule::All { all } => join(all, " AND ", "1", now, p),
        Rule::Any { any } => join(any, " OR ", "0", now, p),
        Rule::Not { not } => Ok(format!("NOT ({})", compile_node(not, now, p)?)),
        Rule::Cond(c) => compile_cond(c, now, p),
    }
}

fn join(rules: &[Rule], sep: &str, empty: &str, now: i64, p: &mut Vec<SqlValue>) -> Result<String> {
    if rules.is_empty() {
        return Ok(empty.to_owned());
    }
    let parts = rules
        .iter()
        .map(|r| compile_node(r, now, p).map(|s| format!("({s})")))
        .collect::<Result<Vec<_>>>()?;
    Ok(parts.join(sep))
}

fn compile_cond(c: &Condition, now: i64, p: &mut Vec<SqlValue>) -> Result<String> {
    let (col, kind) =
        column(&c.field).ok_or_else(|| Error::Rule(format!("unknown field {:?}", c.field)))?;
    let mut bind = |v: SqlValue| {
        p.push(v);
        "?".to_owned()
    };
    Ok(match c.op {
        Op::Eq if kind == Kind::Text => {
            format!("{col} = {} COLLATE NOCASE", bind(to_sql(&c.value, kind)?))
        }
        Op::Eq => format!("{col} = {}", bind(to_sql(&c.value, kind)?)),
        Op::Ne if kind == Kind::Text => {
            format!(
                "{col} IS NOT {} COLLATE NOCASE",
                bind(to_sql(&c.value, kind)?)
            )
        }
        Op::Ne => format!("{col} IS NOT {}", bind(to_sql(&c.value, kind)?)),
        Op::Lt => format!("{col} < {}", bind(to_sql(&c.value, kind)?)),
        Op::Lte => format!("{col} <= {}", bind(to_sql(&c.value, kind)?)),
        Op::Gt => format!("{col} > {}", bind(to_sql(&c.value, kind)?)),
        Op::Gte => format!("{col} >= {}", bind(to_sql(&c.value, kind)?)),
        Op::Between => {
            let arr = c
                .value
                .as_array()
                .filter(|a| a.len() == 2)
                .ok_or_else(|| Error::Rule("between needs [low, high]".into()))?;
            let lo = bind(to_sql(&arr[0], kind)?);
            let hi = bind(to_sql(&arr[1], kind)?);
            format!("{col} BETWEEN {lo} AND {hi}")
        }
        Op::Contains | Op::StartsWith => {
            let s = c
                .value
                .as_str()
                .ok_or_else(|| Error::Rule("contains/starts_with need a string".into()))?;
            let pat = if c.op == Op::Contains {
                format!("%{}%", like_escape(s))
            } else {
                format!("{}%", like_escape(s))
            };
            format!("{col} LIKE {} ESCAPE '\\'", bind(SqlValue::Text(pat)))
        }
        Op::In => {
            let arr = c
                .value
                .as_array()
                .ok_or_else(|| Error::Rule("in needs an array".into()))?;
            if arr.is_empty() {
                return Ok("0".into());
            }
            let marks = arr
                .iter()
                .map(|v| to_sql(v, kind).map(&mut bind))
                .collect::<Result<Vec<_>>>()?;
            format!("{col} IN ({})", marks.join(", "))
        }
        Op::IsNull => format!("{col} IS NULL"),
        Op::NotNull => format!("{col} IS NOT NULL"),
        Op::WithinDays => {
            if kind != Kind::Date {
                return Err(Error::Rule("within_days needs a date field".into()));
            }
            let days = c
                .value
                .as_f64()
                .ok_or_else(|| Error::Rule("within_days needs a number".into()))?;
            let since = now - (days * 86_400.0) as i64;
            format!("{col} >= {}", bind(SqlValue::Integer(since)))
        }
        Op::Harmonic => {
            if c.field != "camelot" {
                return Err(Error::Rule("harmonic only applies to camelot".into()));
            }
            let s = c
                .value
                .as_str()
                .ok_or_else(|| Error::Rule("harmonic needs a key".into()))?;
            let k = crate::keys::MusicalKey::parse(s)
                .ok_or_else(|| Error::Rule(format!("unknown key {s:?}")))?;
            let n = k.camelot_number();
            let (m, o) = if k.minor { ('A', 'B') } else { ('B', 'A') };
            let prev = (n + 10) % 12 + 1;
            let next = n % 12 + 1;
            let set = [
                format!("{n}{m}"),
                format!("{prev}{m}"),
                format!("{next}{m}"),
                format!("{n}{o}"),
            ];
            let marks: Vec<_> = set.into_iter().map(|v| bind(SqlValue::Text(v))).collect();
            format!("{col} IN ({})", marks.join(", "))
        }
    })
}
