//! The logo drawn over exported videos (Swift `VideoLogo`). It belongs to the app, not to a
//! project. The chosen image is copied into `<support>/Video Logos` under a new name each time,
//! so moving or editing the original never changes a video already queued, and a queued job
//! keeps reading the copy it was given.
use std::path::{Path, PathBuf};

use bm::export::LogoCorner;

use crate::support::{Prefs, Support};

pub(crate) const UNREADABLE: &str = "The image could not be read. Choose a PNG, JPEG, HEIC or TIFF file.";

/// What the open panel offers: what ImageIO decodes for the exporter.
pub const EXTENSIONS: [&str; 7] = ["png", "jpg", "jpeg", "heic", "tif", "tiff", "webp"];

pub fn folder(support: &Support) -> PathBuf {
    support.dir.join("Video Logos")
}

/// The logo's copy, when one was chosen and is still there.
pub fn current(support: &Support, prefs: &Prefs) -> Option<PathBuf> {
    if prefs.video_logo_file.is_empty() {
        return None;
    }
    Some(folder(support).join(&prefs.video_logo_file)).filter(|p| p.is_file())
}

pub fn corner(prefs: &Prefs) -> LogoCorner {
    LogoCorner::from_code(&prefs.video_logo_corner).unwrap_or(LogoCorner::BottomRight)
}

/// The logo a new video draws, with its corner: `None` when it is off or missing.
pub fn stamp(support: &Support, prefs: &Prefs) -> Option<(PathBuf, LogoCorner)> {
    if !prefs.video_logo_enabled {
        return None;
    }
    current(support, prefs).map(|f| (f, corner(prefs)))
}

/// The longest side of the panel's preview of the logo.
pub const THUMBNAIL: usize = 128;

/// The logo, decoded and made at most `THUMBNAIL` on its longest side, for the panel's preview.
pub fn thumbnail(path: &Path) -> Option<egui::ColorImage> {
    let img = image::open(path).ok()?;
    let side = THUMBNAIL as u32;
    let img = if img.width() > side || img.height() > side { img.thumbnail(side, side) } else { img };
    let rgba = img.to_rgba8();
    Some(egui::ColorImage::from_rgba_unmultiplied([rgba.width() as usize, rgba.height() as usize], rgba.as_raw()))
}

/// Copies `source` into the logo folder as PNG (`sips` reads what ImageIO reads) and turns the
/// logo on. A source that is not an image leaves the current logo as it was.
pub fn choose(support: &Support, prefs: &mut Prefs, source: &Path) -> Result<PathBuf, String> {
    let copy = convert(&folder(support), source)?;
    apply(prefs, &copy);
    Ok(copy)
}

/// Makes the PNG copy in `dir` (`sips` may take a moment on a large HEIC: call it off the UI
/// thread). Changes no preference.
pub fn convert(dir: &Path, source: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let copy = dir.join(format!("Logo-{}.png", crate::render_queue::uuid()));
    let made = std::process::Command::new("/usr/bin/sips")
        .args(["-s", "format", "png"])
        .arg(source)
        .arg("--out")
        .arg(&copy)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if !made || image::ImageReader::open(&copy).ok().and_then(|r| r.with_guessed_format().ok()).and_then(|r| r.into_dimensions().ok()).is_none() {
        let _ = std::fs::remove_file(&copy);
        return Err(UNREADABLE.to_owned());
    }
    Ok(copy)
}

/// Makes `copy` (in the logo folder) the logo, and turns it on.
pub fn apply(prefs: &mut Prefs, copy: &Path) {
    prefs.video_logo_file = copy.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    prefs.video_logo_enabled = true;
}

pub fn remove(prefs: &mut Prefs) {
    prefs.video_logo_file.clear();
    prefs.video_logo_enabled = false;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumbnail_is_small() {
        let dir = std::env::temp_dir().join(format!("bm-logo-thumb-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let big = dir.join("big.png");
        image::RgbaImage::from_pixel(1000, 400, image::Rgba([1, 2, 3, 255])).save(&big).unwrap();
        let t = thumbnail(&big).expect("decodes");
        assert_eq!(t.size, [THUMBNAIL, THUMBNAIL * 400 / 1000]);
        std::fs::write(dir.join("bad.png"), "x").unwrap();
        assert!(thumbnail(&dir.join("bad.png")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
