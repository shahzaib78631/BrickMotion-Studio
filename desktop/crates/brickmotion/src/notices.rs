//! Messages for the person using the app, shown bottom right until dismissed.

/// How many notices show at once; older ones go.
pub const MAX_SHOWN: usize = 4;

/// Adds `n` as the newest notice: an identical one already shown moves up instead of repeating,
/// and only the newest `MAX_SHOWN` stay.
pub fn push(list: &mut Vec<Notice>, n: Notice) {
    list.retain(|old| *old != n);
    list.push(n);
    let extra = list.len().saturating_sub(MAX_SHOWN);
    list.drain(..extra);
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Notice {
    Error { title: String, detail: String },
    Warning { title: String, detail: String },
}

impl Notice {
    pub fn title(&self) -> &str {
        match self {
            Notice::Error { title, .. } | Notice::Warning { title, .. } => title,
        }
    }

    pub fn detail(&self) -> &str {
        match self {
            Notice::Error { detail, .. } | Notice::Warning { detail, .. } => detail,
        }
    }

    /// "Opened with warnings", listing the first five and counting the rest.
    pub fn from_warnings(warnings: &[String]) -> Option<Notice> {
        if warnings.is_empty() {
            return None;
        }
        let mut detail = warnings.iter().take(5).cloned().collect::<Vec<_>>().join("\n");
        if warnings.len() > 5 {
            detail.push_str(&format!("\nand {} more", warnings.len() - 5));
        }
        Some(Notice::Warning { title: "Opened with warnings".into(), detail })
    }

    pub fn open_failed(e: &bm::OpenError) -> Notice {
        let name = e.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| e.path.display().to_string());
        Notice::Error { title: format!("Couldn't open {name}"), detail: e.message.clone() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warnings_list_five_and_count_the_rest() {
        let w: Vec<String> = (1..=8).map(|i| format!("w{i}")).collect();
        let n = Notice::from_warnings(&w).unwrap();
        assert_eq!(n.title(), "Opened with warnings");
        assert_eq!(n.detail(), "w1\nw2\nw3\nw4\nw5\nand 3 more");
        assert_eq!(Notice::from_warnings(&[]), None);
    }

    fn warn(t: &str) -> Notice {
        Notice::Warning { title: t.into(), detail: String::new() }
    }

    #[test]
    fn keeps_the_newest_few() {
        let mut list = Vec::new();
        for i in 0..10 {
            push(&mut list, warn(&format!("n{i}")));
        }
        assert_eq!(list.len(), MAX_SHOWN);
        assert_eq!(list.last().unwrap().title(), "n9");
        assert_eq!(list[0].title(), format!("n{}", 10 - MAX_SHOWN));
    }

    #[test]
    fn a_repeat_moves_to_the_top_once() {
        let mut list = Vec::new();
        push(&mut list, warn("a"));
        push(&mut list, warn("b"));
        push(&mut list, warn("a"));
        assert_eq!(list.iter().map(Notice::title).collect::<Vec<_>>(), ["b", "a"]);
    }
}
