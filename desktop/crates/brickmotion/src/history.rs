//! Recent and frequent parts, and recent colours, stored in `<support>/history.toml`.
use std::io;

use serde::{Deserialize, Serialize};

use crate::support::{Support, write_atomic};

const MAX_PARTS: usize = 96;
const MAX_COUNT: u32 = 10_000;
const SECTION_LIMIT: usize = 8;
const MAX_COLOURS: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PartEntry {
    pub name: String,
    pub description: String,
    pub category: String,
    pub count: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct History {
    #[serde(default)]
    pub parts: Vec<PartEntry>,
    #[serde(default)]
    pub colours: Vec<i32>,
}

impl History {
    pub fn load(support: &Support) -> History {
        let mut h: History = std::fs::read_to_string(support.file("history.toml"))
            .ok()
            .and_then(|t| toml::from_str(&t).ok())
            .unwrap_or_default();
        h.parts.truncate(MAX_PARTS);
        for p in &mut h.parts {
            p.count = p.count.clamp(1, MAX_COUNT);
        }
        h.colours.truncate(MAX_COLOURS);
        h
    }

    pub fn save(&self, support: &Support) -> io::Result<()> {
        let text = toml::to_string(self).map_err(io::Error::other)?;
        std::fs::create_dir_all(&support.dir)?;
        write_atomic(&support.file("history.toml"), text.as_bytes())
    }

    /// Records a use of `name`: increments its count (capped at 10 000), moves it to the front,
    /// and trims the list to 96 entries.
    pub fn record_part(&mut self, name: &str, description: &str, category: &str) {
        if let Some(pos) = self.parts.iter().position(|p| p.name == name) {
            let mut entry = self.parts.remove(pos);
            entry.count = entry.count.saturating_add(1).min(MAX_COUNT);
            if !description.is_empty() {
                entry.description = description.to_owned();
            }
            if !category.is_empty() {
                entry.category = category.to_owned();
            }
            self.parts.insert(0, entry);
        } else {
            self.parts.insert(
                0,
                PartEntry {
                    name: name.to_owned(),
                    description: description.to_owned(),
                    category: category.to_owned(),
                    count: 1,
                },
            );
            self.parts.truncate(MAX_PARTS);
        }
    }

    /// The 8 most recently used parts, newest first.
    pub fn recent_parts(&self) -> Vec<&PartEntry> {
        self.parts.iter().take(SECTION_LIMIT).collect()
    }

    /// Up to 8 parts used more than once, ordered by count descending then recency.
    pub fn frequent_parts(&self) -> Vec<&PartEntry> {
        let mut indexed: Vec<(usize, &PartEntry)> =
            self.parts.iter().enumerate().filter(|(_, p)| p.count > 1).collect();
        indexed.sort_by(|(ia, a), (ib, b)| b.count.cmp(&a.count).then_with(|| ia.cmp(ib)));
        indexed.into_iter().take(SECTION_LIMIT).map(|(_, p)| p).collect()
    }

    /// Records a chosen colour: newest first, no repeats, at most 8 entries.
    pub fn record_colour(&mut self, code: i32) {
        self.colours.retain(|&c| c != code);
        self.colours.insert(0, code);
        self.colours.truncate(MAX_COLOURS);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> Support {
        let d = std::env::temp_dir().join(format!("bm-history-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Support::at(d)
    }

    #[test]
    fn recent_is_newest_first_eight() {
        let mut h = History::default();
        for i in 0..12 {
            h.record_part(&format!("p{i}.dat"), &format!("Part {i}"), "Brick");
        }
        let recent = h.recent_parts();
        assert_eq!(recent.len(), 8);
        assert_eq!(recent[0].name, "p11.dat");
        assert_eq!(recent[7].name, "p4.dat");
    }

    #[test]
    fn frequent_needs_two_uses_sorted_by_count_then_recency() {
        let mut h = History::default();
        h.record_part("once.dat", "Once", "Brick");
        h.record_part("a.dat", "A", "Brick");
        h.record_part("a.dat", "A", "Brick"); // count 2, older
        h.record_part("b.dat", "B", "Brick");
        h.record_part("b.dat", "B", "Brick");
        h.record_part("b.dat", "B", "Brick"); // count 3
        h.record_part("c.dat", "C", "Brick");
        h.record_part("c.dat", "C", "Brick"); // count 2, newer than a
        let freq: Vec<&str> = h.frequent_parts().iter().map(|p| p.name.as_str()).collect();
        assert_eq!(freq, vec!["b.dat", "c.dat", "a.dat"]);
    }

    #[test]
    fn parts_cap_at_96() {
        let mut h = History::default();
        for i in 0..120 {
            h.record_part(&format!("p{i}.dat"), "P", "Brick");
        }
        assert_eq!(h.parts.len(), 96);
        assert_eq!(h.parts[0].name, "p119.dat");
    }

    #[test]
    fn colours_dedupe_newest_first_cap_8() {
        let mut h = History::default();
        for c in 0..10 {
            h.record_colour(c);
        }
        assert_eq!(h.colours.len(), 8);
        assert_eq!(h.colours[0], 9);
        h.record_colour(4);
        assert_eq!(h.colours.len(), 8);
        assert_eq!(h.colours[0], 4);
        assert_eq!(h.colours.iter().filter(|&&c| c == 4).count(), 1);
    }

    #[test]
    fn round_trips_through_history_toml() {
        let s = tmp("rt");
        let mut h = History::default();
        h.record_part("3001.dat", "Brick 2 x 4", "Brick");
        h.record_part("3001.dat", "Brick 2 x 4", "Brick");
        h.record_colour(4);
        h.record_colour(71);
        h.save(&s).unwrap();
        let back = History::load(&s);
        assert_eq!(back, h);
    }
}
