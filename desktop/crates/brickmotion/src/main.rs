use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "usage: brickmotion [model]\n       brickmotion --snapshot <out.png> [--size WxH] <model>";

/// What the command line asked for.
enum Run {
    Window(Option<PathBuf>),
    Snapshot { out: PathBuf, size: (u32, u32), model: PathBuf },
}

fn parse(args: &[String]) -> Result<Run, String> {
    if !args.iter().any(|a| a == "--snapshot") {
        return Ok(Run::Window(args.first().map(PathBuf::from)));
    }
    let (mut out, mut size, mut model) = (None, (1280, 800), None);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--snapshot" => out = Some(PathBuf::from(it.next().ok_or("--snapshot needs an output file")?)),
            "--size" => {
                let s = it.next().ok_or("--size needs WxH")?;
                let (w, h) = s.split_once('x').ok_or_else(|| format!("--size {s}: expected WxH"))?;
                size = (w.parse().map_err(|_| format!("--size {s}: bad width"))?, h.parse().map_err(|_| format!("--size {s}: bad height"))?);
            }
            m => model = Some(PathBuf::from(m)),
        }
    }
    Ok(Run::Snapshot { out: out.ok_or("--snapshot needs an output file")?, size, model: model.ok_or("--snapshot needs a model")? })
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse(&args) {
        Err(e) => {
            eprintln!("brickmotion: {e}\n{USAGE}");
            ExitCode::from(1)
        }
        Ok(Run::Snapshot { out, size, model }) => match brickmotion::snapshot(&model, &out, size) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("brickmotion: {e}");
                ExitCode::from(1)
            }
        },
        Ok(Run::Window(path)) => {
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
            let r = eframe::run_native("BrickMotion", options, Box::new(|cc| {
                let mut app = brickmotion::BrickMotionApp::new(cc, path);
                app.install_menu(&cc.egui_ctx);
                Ok(Box::new(app))
            }));
            match r {
                Ok(()) => ExitCode::SUCCESS,
                Err(e) => {
                    eprintln!("brickmotion: {e}");
                    ExitCode::from(1)
                }
            }
        }
    }
}
