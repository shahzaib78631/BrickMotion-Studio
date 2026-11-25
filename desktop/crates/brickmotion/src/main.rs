use std::path::PathBuf;

fn main() -> eframe::Result {
    let path = std::env::args_os().nth(1).map(PathBuf::from);
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1440.0, 900.0])
            .with_min_inner_size([960.0, 640.0])
            .with_title("BrickMotion")
            .with_app_id("com.brickmotion.studio.rs")
            // Our own title bar sits beside the traffic lights.
            .with_fullsize_content_view(true)
            .with_titlebar_shown(false)
            .with_title_shown(false),
        ..Default::default()
    };
    eframe::run_native("BrickMotion", options, Box::new(|cc| Ok(Box::new(brickmotion::BrickMotionApp::new(cc, path)))))
}
