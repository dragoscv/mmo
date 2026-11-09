//! Minimal element tree over quick-xml (attributes + children; text content is ignored,
//! which is all rekordbox XML and Traktor NML need).

use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};

use crate::util::xml_unescape;
use crate::{Error, Result};

#[derive(Debug, Clone, Default)]
pub struct Node {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Node>,
}

impl Node {
    pub fn attr(&self, key: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// Attribute, trimmed, `None` when empty.
    pub fn text(&self, key: &str) -> Option<String> {
        self.attr(key)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    }

    pub fn f64(&self, key: &str) -> Option<f64> {
        self.attr(key)
            .and_then(|s| s.trim().replace(',', ".").parse::<f64>().ok())
            .filter(|v| v.is_finite())
    }

    pub fn i64(&self, key: &str) -> Option<i64> {
        let s = self.attr(key)?.trim();
        s.parse::<i64>()
            .ok()
            .or_else(|| s.parse::<f64>().ok().map(|f| f as i64))
    }

    pub fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|c| c.name == name)
    }

    pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> + 'a {
        self.children.iter().filter(move |c| c.name == name)
    }
}

fn element(e: &BytesStart<'_>) -> Node {
    let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
    let attrs = e
        .attributes()
        .filter_map(std::result::Result::ok)
        .map(|a| {
            (
                String::from_utf8_lossy(a.key.as_ref()).into_owned(),
                xml_unescape(&String::from_utf8_lossy(&a.value)),
            )
        })
        .collect();
    Node {
        name,
        attrs,
        children: Vec::new(),
    }
}

/// Parses a document and returns its root element.
pub fn parse(xml: &str) -> Result<Node> {
    let xml = xml.trim_start_matches('\u{feff}');
    let mut reader = Reader::from_str(xml);
    let mut stack: Vec<Node> = Vec::new();
    let mut root: Option<Node> = None;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => stack.push(element(&e)),
            Ok(Event::Empty(e)) => {
                let node = element(&e);
                match stack.last_mut() {
                    Some(parent) => parent.children.push(node),
                    None => root = Some(node),
                }
            }
            Ok(Event::End(_)) => {
                let node = stack
                    .pop()
                    .ok_or_else(|| Error::Xml("unbalanced end tag".into()))?;
                match stack.last_mut() {
                    Some(parent) => parent.children.push(node),
                    None => root = Some(node),
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(e) => {
                return Err(Error::Xml(format!(
                    "at byte {}: {e}",
                    reader.buffer_position()
                )));
            }
        }
    }
    if !stack.is_empty() {
        return Err(Error::Xml("unexpected end of document".into()));
    }
    root.ok_or_else(|| Error::Xml("empty document".into()))
}
