// Every colour the chrome draws comes from `theme.rs`, so the dark and light appearances both
// work. Data colours (a part's own LDraw colour, a key's channel colour) are marked on the line
// with `// data colour`.
use std::path::Path;

fn rust_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

#[test]
fn no_literal_colours_outside_the_theme() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    let literal = ["Color32::from_rgb", "Color32::from_rgba", "Color32::from_gray", "Color32::from_white_alpha", "Color32::from_black_alpha", "Color32::WHITE", "Color32::BLACK", "Color32::LIGHT_", "Color32::DARK_", "Color32::GRAY", "Color32::RED", "Color32::YELLOW", "Color32::GREEN"];
    let mut found = Vec::new();
    for f in files {
        if f.ends_with("theme.rs") || f.ends_with("theme_catalogue.rs") {
            continue;
        }
        let text = std::fs::read_to_string(&f).unwrap();
        // Unit tests may build whatever colours they check against.
        let body = text.split("#[cfg(test)]").next().unwrap_or_default();
        for (i, line) in body.lines().enumerate() {
            if literal.iter().any(|l| line.contains(l)) && !line.contains("// data colour") {
                found.push(format!("{}:{}: {}", f.strip_prefix(&src).unwrap().display(), i + 1, line.trim()));
            }
        }
    }
    assert!(found.is_empty(), "{} literal colours outside theme.rs:\n{}", found.len(), found.join("\n"));
}

#[test]
fn every_theme_keeps_text_readable() {
    fn lum(c: egui::Color32) -> f32 {
        let f = |v: u8| {
            let v = f32::from(v) / 255.0;
            if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
        };
        0.2126 * f(c.r()) + 0.7152 * f(c.g()) + 0.0722 * f(c.b())
    }
    fn contrast(a: egui::Color32, b: egui::Color32) -> f32 {
        let (x, y) = (lum(a), lum(b));
        (x.max(y) + 0.05) / (x.min(y) + 0.05)
    }
    let all = brickmotion::theme::catalogue();
    assert!(all.len() >= 27, "{} themes", all.len());
    let mut ids = std::collections::HashSet::new();
    for d in all {
        assert!(ids.insert(d.id), "duplicate id {}", d.id);
        let t = d.theme;
        assert!(contrast(t.text1, t.bg1) >= 7.0, "{}: body text", d.name);
        assert!(contrast(t.text2, t.bg1) >= 3.0, "{}: secondary text", d.name);
        assert!(contrast(t.on_accent, t.accent) >= 3.0, "{}: text on the accent", d.name);
    }
    assert_eq!(all[0].id, "dark");
    assert_eq!(all[1].id, "light");
}

#[test]
fn match_system_follows_the_mac_and_unknown_ids_fall_back_to_dark() {
    use brickmotion::theme::{MATCH_SYSTEM, resolve};
    assert!(resolve(MATCH_SYSTEM, true).dark);
    assert!(!resolve(MATCH_SYSTEM, false).dark);
    assert!(resolve("no-such-theme", false).dark);
    assert!(!resolve("solarized-light", true).dark);
}

#[test]
fn orange_is_only_the_playhead() {
    // The playhead colour may be used by the timeline's playhead and flag, the flight-path marker
    // at the current time, and the theme previews; nothing else (logo, icons, buttons).
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let allowed = ["chrome/timeline.rs", "flight_path.rs", "chrome/preferences.rs"];
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    let mut found = Vec::new();
    for f in files {
        let rel = f.strip_prefix(&src).unwrap().display().to_string();
        if rel.starts_with("theme") || allowed.contains(&rel.as_str()) {
            continue;
        }
        let text = std::fs::read_to_string(&f).unwrap();
        for (i, line) in text.lines().enumerate() {
            let colour_use = line.match_indices(".playhead").any(|(at, m)| {
                !line[at + m.len()..].starts_with(|c: char| c.is_alphanumeric() || c == '_')
            });
            if colour_use && !line.trim_start().starts_with("//") {
                found.push(format!("{rel}:{}: {}", i + 1, line.trim()));
            }
        }
    }
    assert!(found.is_empty(), "playhead orange used outside the playhead:\n{}", found.join("\n"));
}
