//! The project's look, file exports, and the export windows' options (bmapp/export_options).
use std::ffi::{CString, c_char};
use std::path::Path;

use bm_sys as sys;

use crate::session::take_change;
use crate::{Camera, Changed, Session, Vec3, borrowed, take_string};

/// Holds the C strings a call borrows until it returns.
#[derive(Default)]
struct Keep(Vec<CString>);

impl Keep {
    fn add(&mut self, s: &str) -> *const c_char {
        let c = CString::new(s.replace('\0', "")).unwrap_or_default();
        let p = c.as_ptr();
        self.0.push(c);
        p
    }
}

fn take_strings(h: *mut sys::BmStrings) -> Vec<String> {
    if h.is_null() {
        return Vec::new();
    }
    let n = unsafe { sys::bm_strings_len(h) };
    let out = (0..n).map(|i| borrowed(unsafe { sys::bm_strings_at(h, i) })).collect();
    unsafe { sys::bm_strings_free(h) };
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Shading {
    #[default]
    Standard,
    Studio,
    Neural,
    HybridRt,
    ScreenSpaceGi,
    PathTraced,
}

impl Shading {
    pub const ALL: [Shading; 6] =
        [Self::Standard, Self::Studio, Self::Neural, Self::HybridRt, Self::ScreenSpaceGi, Self::PathTraced];
    fn from_raw(v: i32) -> Self {
        Self::ALL.get(v as usize).copied().unwrap_or_default()
    }
    fn to_raw(self) -> i32 {
        Self::ALL.iter().position(|s| *s == self).unwrap_or(0) as i32
    }
}

/// How the project looks in the editor and every export.
#[derive(Debug, Clone, PartialEq)]
pub struct RenderLook {
    /// A web scene id (`scenes()`); "" follows the editor's appearance.
    pub scene: String,
    pub shading: Shading,
    pub edges: bool,
    pub shadows: bool,
    pub ambient_occlusion: bool,
    pub floor: bool,
    pub raytraced_glass: bool,
    pub world_gi_occlusion: bool,
    pub lights_follow_camera: bool,
    /// Path tracing: samples a pixel, 8–1024.
    pub path_samples: i32,
    /// Studs and curves from 48-sided primitives (`--no-smooth-curves` when off).
    pub smooth_curves: bool,
    /// Narrow shading fillets on convex edges (`--no-rounded-edges`).
    pub rounded_edges: bool,
    /// A soft base where a stud meets the deck (`--no-soft-stud-roots`).
    pub soft_stud_roots: bool,
}

impl Default for RenderLook {
    fn default() -> Self {
        RenderLook {
            scene: String::new(),
            shading: Shading::Standard,
            edges: true,
            shadows: true,
            ambient_occlusion: true,
            floor: true,
            raytraced_glass: false,
            world_gi_occlusion: true,
            lights_follow_camera: false,
            path_samples: 64,
            smooth_curves: true,
            rounded_edges: true,
            soft_stud_roots: true,
        }
    }
}

impl RenderLook {
    fn from_raw(l: &sys::BmRenderLook) -> Self {
        RenderLook {
            scene: borrowed(l.scene),
            shading: Shading::from_raw(l.shading),
            edges: l.edges,
            shadows: l.shadows,
            ambient_occlusion: l.ambient_occlusion,
            floor: l.floor,
            raytraced_glass: l.raytraced_glass,
            world_gi_occlusion: l.world_gi_occlusion,
            lights_follow_camera: l.lights_follow_camera,
            path_samples: l.path_samples,
            smooth_curves: l.smooth_curves,
            rounded_edges: l.rounded_edges,
            soft_stud_roots: l.soft_stud_roots,
        }
    }
    fn to_raw(&self, keep: &mut Keep) -> sys::BmRenderLook {
        sys::BmRenderLook {
            scene: keep.add(&self.scene),
            shading: self.shading.to_raw(),
            edges: self.edges,
            shadows: self.shadows,
            ambient_occlusion: self.ambient_occlusion,
            floor: self.floor,
            raytraced_glass: self.raytraced_glass,
            world_gi_occlusion: self.world_gi_occlusion,
            lights_follow_camera: self.lights_follow_camera,
            path_samples: self.path_samples,
            smooth_curves: self.smooth_curves,
            rounded_edges: self.rounded_edges,
            soft_stud_roots: self.soft_stud_roots,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SceneCollection {
    Photo,
    Render,
    Classic,
}

/// A web scene's backdrop: one sRGB colour (0–1) and whether it has a floor.
#[derive(Debug, Clone, PartialEq)]
pub struct ScenePreset {
    pub id: String,
    pub label: String,
    pub hint: String,
    pub collection: SceneCollection,
    pub background: Vec3,
    pub floor: bool,
}

pub fn scenes() -> Vec<ScenePreset> {
    let h = unsafe { sys::bm_scenes() };
    if h.is_null() {
        return Vec::new();
    }
    let n = unsafe { sys::bm_scenes_len(h) };
    let out = (0..n)
        .map(|i| {
            let p = unsafe { sys::bm_scenes_at(h, i) };
            ScenePreset {
                id: borrowed(p.id),
                label: borrowed(p.label),
                hint: borrowed(p.hint),
                collection: match p.collection {
                    0 => SceneCollection::Photo,
                    1 => SceneCollection::Render,
                    _ => SceneCollection::Classic,
                },
                background: Vec3::from_raw(p.background),
                floor: p.floor,
            }
        })
        .collect();
    unsafe { sys::bm_scenes_free(h) };
    out
}

impl Session {
    pub fn render_look(&self) -> RenderLook {
        RenderLook::from_raw(&unsafe { sys::bm_session_render_look(self.raw) })
    }

    /// One undo step.
    pub fn set_render_look(&self, look: &RenderLook) -> Changed {
        let mut keep = Keep::default();
        let raw = look.to_raw(&mut keep);
        take_change(unsafe { sys::bm_session_set_render_look(self.raw, raw) })
    }

    /// The plan as JSON (Export Plan).
    pub fn plan_bytes(&self) -> String {
        take_string(unsafe { sys::bm_session_plan_bytes(self.raw) })
    }

    /// The whole model as an LDraw MPD (Export LDraw).
    pub fn mpd_bytes(&self) -> String {
        take_string(unsafe { sys::bm_session_mpd_bytes(self.raw) })
    }

    pub fn submodel_mpd_bytes(&self, model: &str) -> String {
        let mut keep = Keep::default();
        let m = keep.add(model);
        take_string(unsafe { sys::bm_session_submodel_mpd_bytes(self.raw, m) })
    }

    /// The submodel as a project of its own.
    pub fn submodel_project_bytes(&self, model: &str) -> String {
        let mut keep = Keep::default();
        let m = keep.add(model);
        take_string(unsafe { sys::bm_session_submodel_project_bytes(self.raw, m) })
    }
}

macro_rules! ordinal_enum {
    ($(#[$m:meta])* $name:ident { $($v:ident),+ $(,)? } default $d:ident) => {
        $(#[$m])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name { $($v),+ }
        impl Default for $name {
            fn default() -> Self { Self::$d }
        }
        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$v),+];
            fn to_raw(self) -> i32 { Self::ALL.iter().position(|x| *x == self).unwrap_or(0) as i32 }
            #[allow(dead_code)]
            fn from_raw(v: i32) -> Self { Self::ALL.get(v as usize).copied().unwrap_or(Self::$d) }
        }
    };
}

ordinal_enum!(MovieSource { Build, Keyframes, Turntable } default Build);
ordinal_enum!(
    /// 16:9, 9:16, 4:5, 1:1.
    FrameShape { Landscape, Vertical, Portrait, Square } default Landscape
);
ordinal_enum!(MovieResolution { Small, Standard, Large } default Standard);
ordinal_enum!(MovieQuality { Compact, Standard, High } default Standard);
ordinal_enum!(
    /// Who films a video: the automatic camera, the Camera track, the viewport's heading or a
    /// saved scene camera.
    MovieCamera { Director, Track, Viewport, Saved } default Director
);
ordinal_enum!(LogoCorner { TopLeft, TopRight, BottomLeft, BottomRight } default BottomRight);

impl MovieSource {
    pub fn title(self) -> &'static str {
        match self {
            Self::Build => "Build",
            Self::Keyframes => "Keyframes",
            Self::Turntable => "Turntable",
        }
    }
}

impl FrameShape {
    pub fn title(self) -> &'static str {
        match self {
            Self::Landscape => "Landscape",
            Self::Vertical => "Vertical",
            Self::Portrait => "Portrait",
            Self::Square => "Square",
        }
    }
    pub fn ratio(self) -> &'static str {
        match self {
            Self::Landscape => "16:9",
            Self::Vertical => "9:16",
            Self::Portrait => "4:5",
            Self::Square => "1:1",
        }
    }
}

impl MovieQuality {
    pub fn title(self) -> &'static str {
        match self {
            Self::Compact => "Compact",
            Self::Standard => "Standard",
            Self::High => "High",
        }
    }
}

impl LogoCorner {
    pub fn title(self) -> &'static str {
        match self {
            Self::TopLeft => "Top Left",
            Self::TopRight => "Top Right",
            Self::BottomLeft => "Bottom Left",
            Self::BottomRight => "Bottom Right",
        }
    }
    /// "tl", "tr", "bl", "br", as saved and as the helper takes it.
    pub fn code(self) -> &'static str {
        ["tl", "tr", "bl", "br"][self.to_raw() as usize]
    }
    pub fn from_code(code: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|c| c.code() == code)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum StillQuality {
    Draft,
    #[default]
    Standard,
    Final,
}

impl StillQuality {
    pub const ALL: [StillQuality; 3] = [Self::Draft, Self::Standard, Self::Final];
    pub fn samples(self) -> i32 {
        match self {
            Self::Draft => 32,
            Self::Standard => 128,
            Self::Final => 512,
        }
    }
    pub fn title(self) -> &'static str {
        match self {
            Self::Draft => "Draft",
            Self::Standard => "Standard",
            Self::Final => "Final",
        }
    }
}

/// The viewport's heading in degrees, as the helper's --azimuth/--elevation/--fov take it.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ViewAngles {
    pub present: bool,
    pub yaw_deg: f64,
    pub pitch_deg: f64,
    pub fov_deg: f64,
    pub orthographic: bool,
}

impl ViewAngles {
    fn to_raw(self) -> sys::BmViewAngles {
        sys::BmViewAngles {
            present: self.present,
            yaw_deg: self.yaw_deg,
            pitch_deg: self.pitch_deg,
            fov_deg: self.fov_deg,
            orthographic: self.orthographic,
        }
    }
}

pub fn view_angles(camera: Camera) -> ViewAngles {
    let a = unsafe { sys::bm_view_angles(camera.to_raw()) };
    ViewAngles {
        present: a.present,
        yaw_deg: a.yaw_deg,
        pitch_deg: a.pitch_deg,
        fov_deg: a.fov_deg,
        orthographic: a.orthographic,
    }
}

/// What Export Movie films. The camera is resolved by the caller: Track only when
/// `movie_allows_track`, Saved only when saved cameras are offered.
#[derive(Debug, Clone, PartialEq)]
pub struct MovieChoice {
    pub source: MovieSource,
    pub shape: FrameShape,
    pub resolution: MovieResolution,
    pub quality: MovieQuality,
    pub fps: i32,
    pub turntable_seconds: i32,
    pub camera: MovieCamera,
    pub scene_camera_id: String,
    pub snap_audio: bool,
    pub standard_preview: bool,
    pub angles: ViewAngles,
    pub model_path: Vec<String>,
    /// "" draws no logo.
    pub logo: String,
    pub logo_corner: LogoCorner,
}

impl Default for MovieChoice {
    fn default() -> Self {
        MovieChoice {
            source: MovieSource::Build,
            shape: FrameShape::Landscape,
            resolution: MovieResolution::Standard,
            quality: MovieQuality::Standard,
            fps: 30,
            turntable_seconds: 8,
            camera: MovieCamera::Director,
            scene_camera_id: String::new(),
            snap_audio: false,
            standard_preview: false,
            angles: ViewAngles::default(),
            model_path: Vec::new(),
            logo: String::new(),
            logo_corner: LogoCorner::BottomRight,
        }
    }
}

/// Raw choice plus the strings and pointer array it borrows.
struct RawMovie {
    _keep: Keep,
    _path: Vec<*const c_char>,
    raw: sys::BmMovieChoice,
}

impl MovieChoice {
    fn raw(&self) -> RawMovie {
        let mut keep = Keep::default();
        let path: Vec<*const c_char> = self.model_path.iter().map(|m| keep.add(m)).collect();
        let raw = sys::BmMovieChoice {
            source: self.source.to_raw(),
            shape: self.shape.to_raw(),
            resolution: self.resolution.to_raw(),
            quality: self.quality.to_raw(),
            fps: self.fps,
            turntable_seconds: self.turntable_seconds,
            camera: self.camera.to_raw(),
            scene_camera_id: keep.add(&self.scene_camera_id),
            snap_audio: self.snap_audio,
            standard_preview: self.standard_preview,
            angles: self.angles.to_raw(),
            model_path: path.as_ptr(),
            model_path_len: path.len(),
            logo: keep.add(&self.logo),
            logo_corner: self.logo_corner.to_raw(),
        };
        RawMovie { _keep: keep, _path: path, raw }
    }
}

/// What Export Still renders.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct StillChoice {
    pub shape: FrameShape,
    pub large: bool,
    pub quality: StillQuality,
    /// Film from the viewport's heading (when `angles.present`).
    pub viewport_angle: bool,
    pub angles: ViewAngles,
}

impl StillChoice {
    fn raw(&self) -> sys::BmStillChoice {
        sys::BmStillChoice {
            shape: self.shape.to_raw(),
            large: self.large,
            samples: self.quality.samples(),
            viewport_angle: self.viewport_angle,
            angles: self.angles.to_raw(),
        }
    }
}

pub fn movie_size(shape: FrameShape, resolution: MovieResolution) -> (i32, i32) {
    let s = unsafe { sys::bm_movie_size(shape.to_raw(), resolution.to_raw()) };
    (s.width, s.height)
}

pub fn still_size(shape: FrameShape, large: bool) -> (i32, i32) {
    let s = unsafe { sys::bm_still_size(shape.to_raw(), large) };
    (s.width, s.height)
}

pub fn movie_bit_rate(width: i32, height: i32, fps: i32, quality: MovieQuality) -> i32 {
    unsafe { sys::bm_movie_bit_rate(width, height, fps, quality.to_raw()) }
}

/// The movie helper's options, in the Swift sheet's order.
pub fn movie_arguments(choice: &MovieChoice) -> Vec<String> {
    let raw = choice.raw();
    take_strings(unsafe { sys::bm_movie_arguments(raw.raw) })
}

/// "Build · 1920 × 1080 · 30 fps", plus quality and " · Logo".
pub fn movie_summary(choice: &MovieChoice) -> String {
    let raw = choice.raw();
    take_string(unsafe { sys::bm_movie_summary(raw.raw) })
}

pub fn still_arguments(choice: &StillChoice, look: &RenderLook) -> Vec<String> {
    let mut keep = Keep::default();
    let l = look.to_raw(&mut keep);
    take_strings(unsafe { sys::bm_still_arguments(choice.raw(), l) })
}

pub fn still_summary(choice: &StillChoice, logo: bool) -> String {
    take_string(unsafe { sys::bm_still_summary(choice.raw(), logo) })
}

/// The camera a new Export Movie window starts with. Saved means the scene's active camera.
pub fn default_movie_camera(session: &Session, batch: bool, has_angle: bool) -> MovieCamera {
    MovieCamera::from_raw(unsafe { sys::bm_default_movie_camera(session.raw, batch, has_angle) })
}

pub fn movie_allows_track(session: &Session, choice: &MovieChoice, batch: bool, focused_model_chosen: bool) -> bool {
    let raw = choice.raw();
    unsafe { sys::bm_movie_allows_track(session.raw, raw.raw, batch, focused_model_chosen) }
}

/// One submodel video: its name and the focus path that opens it.
#[derive(Debug, Clone, PartialEq)]
pub struct VideoTarget {
    pub title: String,
    pub path: Vec<String>,
}

/// A video for each submodel with parts, once per shared definition. With `ids`, only those
/// outline rows.
pub fn submodel_video_targets(session: &Session, ids: Option<&[String]>) -> Vec<VideoTarget> {
    let mut keep = Keep::default();
    let list: Vec<*const c_char> = ids.unwrap_or(&[]).iter().map(|i| keep.add(i)).collect();
    let h = unsafe { sys::bm_submodel_video_targets(session.raw, list.as_ptr(), list.len(), ids.is_some()) };
    if h.is_null() {
        return Vec::new();
    }
    let n = unsafe { sys::bm_video_targets_len(h) };
    let out = (0..n)
        .map(|i| VideoTarget {
            title: borrowed(unsafe { sys::bm_video_targets_title(h, i) }),
            path: (0..unsafe { sys::bm_video_targets_path_len(h, i) })
                .map(|j| borrowed(unsafe { sys::bm_video_targets_path_at(h, i, j) }))
                .collect(),
        })
        .collect();
    unsafe { sys::bm_video_targets_free(h) };
    out
}

/// A batch movie's file name: no control characters or / : \, at most 60 characters.
pub fn safe_file_stem(name: &str) -> String {
    let mut keep = Keep::default();
    let n = keep.add(name);
    take_string(unsafe { sys::bm_safe_file_stem(n) })
}

/// A model's name as people read it (the engine's displayName).
pub fn display_name(raw: &str) -> String {
    let mut keep = Keep::default();
    let r = keep.add(raw);
    take_string(unsafe { sys::bm_display_name(r) })
}

/// Draws the logo over a PNG in place.
pub fn stamp_logo(png: &Path, logo: &Path, corner: LogoCorner) -> Result<(), String> {
    let mut keep = Keep::default();
    let p = keep.add(&png.to_string_lossy());
    let l = keep.add(&logo.to_string_lossy());
    let failure = take_string(unsafe { sys::bm_stamp_logo(p, l, corner.to_raw()) });
    if failure.is_empty() { Ok(()) } else { Err(failure) }
}

/// The movie helper (`project --out file options…`): renders the movie, 0 on success.
pub fn run_editor_movie(args: &[String]) -> i32 {
    let mut keep = Keep::default();
    let list: Vec<*const c_char> = args.iter().map(|a| keep.add(a)).collect();
    unsafe { sys::bm_run_editor_movie(list.as_ptr(), list.len()) }
}
