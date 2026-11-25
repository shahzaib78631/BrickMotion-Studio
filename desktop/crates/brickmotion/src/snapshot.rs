//! `brickmotion --snapshot`: open a model, frame it, and write one PNG without a window.
use std::path::Path;

use crate::Theme;

/// Draw calls before giving up on the picture settling.
const MAX_DRAWS: usize = 600;

pub fn snapshot(path: &Path, out: &Path, size: (u32, u32)) -> Result<(), String> {
    if size.0 == 0 || size.1 == 0 {
        return Err(format!("the size {}x{} has no pixels", size.0, size.1));
    }
    let (s, _) = crate::loader::open_model(path).map_err(|e| e.to_string())?;
    if s.piece_count() == 0 {
        return Err(format!("{}: no pieces were found in this file", path.display()));
    }
    let mut doc = bm::Document::new(s);
    let vp = doc.viewport().ok_or("this Mac has no Metal device, so nothing can be drawn")?;
    let bg = Theme::DARK.bg1;
    vp.set_background([bg.r(), bg.g(), bg.b()].map(|c| c as f64 / 255.0));
    vp.resize(size.0, size.1, 1.0);
    vp.fit_all();
    for _ in 0..MAX_DRAWS {
        if !vp.draw() {
            break;
        }
    }
    let mut frame = bm::Frame::default();
    vp.read_frame(&mut frame);
    if (frame.width, frame.height) != size {
        return Err(format!("the engine drew {}x{} instead of {}x{}", frame.width, frame.height, size.0, size.1));
    }
    image::save_buffer(out, &frame.rgba, frame.width, frame.height, image::ExtendedColorType::Rgba8)
        .map_err(|e| format!("{}: {e}", out.display()))
}
