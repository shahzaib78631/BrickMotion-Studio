//! The viewport's right-click menus: one for a piece (acting on the selection it belongs to) and
//! one for empty space. Rows are built as data first, so tests can read them, then drawn with the
//! shared `chrome::menu` rows. Every command row runs through `commands::run` like the menu bar.
use egui::Ui;

use crate::BrickMotionApp;
use crate::chrome::menu;
use crate::commands::{Shortcut, enabled, find, run, title};
use crate::icons::Icon;
use crate::viewport::ContextTarget;

/// What choosing a row does.
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Run(&'static str),
    MoveToStep(usize),
    MoveToModel(String),
    SelectGroup(String),
    UseColour(i32),
    OpenSubmodel(Vec<String>),
    TurnWaiting(u32, f64),
}

/// One row of a context menu.
#[derive(Clone, Debug, PartialEq)]
pub enum Row {
    Header { title: String, subtitle: String },
    Section(&'static str),
    Separator,
    Item { icon: Option<Icon>, label: String, keys: Option<String>, action: Action, enabled: bool, danger: bool, checked: Option<bool> },
    Sub { icon: Option<Icon>, label: String, rows: Vec<Row> },
}

impl Row {
    fn plain(icon: Option<Icon>, label: impl Into<String>, action: Action, enabled: bool) -> Row {
        Row::Item { icon, label: label.into(), keys: None, action, enabled, danger: false, checked: None }
    }
}

/// A registry command as a row: its live title, shortcut, icon and enabled state.
fn cmd(app: &BrickMotionApp, id: &'static str) -> Row {
    let c = find(id).expect("context menu commands are registered");
    let ctx = app.ctx();
    Row::Item {
        icon: Some(c.icon),
        label: title(c, &ctx),
        keys: c.keys.and_then(Shortcut::parse).map(|s| s.label()),
        action: Action::Run(c.id),
        enabled: enabled(c, &ctx),
        danger: id == "edit.delete",
        checked: None,
    }
}

/// The rows for `target`, as they stand now.
pub fn rows(app: &mut BrickMotionApp, target: ContextTarget) -> Vec<Row> {
    match target {
        ContextTarget::Piece(p) => piece_rows(app, p),
        ContextTarget::Empty => empty_rows(app),
    }
}

fn piece_rows(app: &mut BrickMotionApp, piece: u32) -> Vec<Row> {
    use Row::{Separator as Sep, Sub};
    let mut out = Vec::new();
    let waiting = app.doc.viewport().filter(|vp| vp.can_turn_waiting_part(piece)).map(|vp| vp.waiting_turn_to_match(piece));
    if let Some(match_deg) = waiting {
        out.push(Row::Section("Waiting on the floor"));
        out.push(Row::plain(Some(Icon::Rotate), "Turn Waiting Part 90°", Action::TurnWaiting(piece, 90.0), true));
        out.push(Row::plain(Some(Icon::Undo), "Turn Waiting Part −90°", Action::TurnWaiting(piece, -90.0), true));
        out.push(Row::plain(Some(Icon::Target), "Turn to Match", Action::TurnWaiting(piece, match_deg), match_deg.abs() > 1e-3));
        // A waiting part is not part of the selection the rows below act on.
        if !app.doc.session().selection().contains(&piece) {
            return out;
        }
        out.push(Sep);
    }

    let snap = app.snapshot();
    let info = snap.described.iter().find(|d| d.piece == piece).or(snap.described.first()).cloned();
    let s = app.doc.session();
    let sel = s.selection();
    // Inside a submodel use of the model being edited (its path is relative to the root).
    let in_use = info.as_ref().is_some_and(|d| !d.submodel_path.is_empty() && d.submodel_path != s.focus_path().join("/"));
    if let Some(d) = &info {
        let title = if sel.len() > 1 { format!("{} pieces", sel.len()) } else { d.description.clone() };
        let subtitle = if in_use && sel.len() > 1 {
            format!("Submodel {} · Step {}", d.submodel_path.rsplit('/').next().unwrap_or_default(), d.step + 1)
        } else {
            format!("{} · {} · Step {}", d.part.trim_end_matches(".dat"), d.color_name, d.step + 1)
        };
        out.push(Row::Header { title, subtitle });
        out.push(Sep);
    }

    if let Some(d) = info.as_ref().filter(|d| in_use && !d.submodel_path.is_empty()) {
        let path: Vec<String> = d.submodel_path.split('/').map(str::to_owned).collect();
        out.push(Row::Item {
            icon: Some(Icon::LookAt),
            label: "Open Submodel".into(),
            keys: Some("double-click".into()),
            action: Action::OpenSubmodel(path),
            enabled: true,
            danger: false,
            checked: None,
        });
    }
    out.push(cmd(app, "model.what_fits"));
    out.push(cmd(app, "view.frame_selection"));
    out.push(Sep);

    out.push(cmd(app, "model.rotate"));
    out.push(cmd(app, "edit.raise"));
    out.push(cmd(app, "edit.lower"));
    let s = app.doc.session();
    let steps = s.steps();
    let current = info.as_ref().map(|d| d.step.max(0) as usize);
    let step_rows = steps
        .iter()
        .map(|st| {
            let here = Some(st.index) == current && sel.len() == 1;
            let label = if st.title.is_empty() { format!("Step {}", st.index + 1) } else { format!("Step {} · {}", st.index + 1, st.title) };
            Row::plain(None, label, Action::MoveToStep(st.index), !here)
        })
        .collect();
    out.push(Sub { icon: Some(Icon::Step), label: "Move to Step".into(), rows: step_rows });
    out.push(Sep);

    out.push(cmd(app, "model.recolour"));
    out.push(cmd(app, "model.replace"));
    let colour = s.part_color(piece);
    out.push(Row::plain(Some(Icon::Paint), "Use This Colour for New Parts", Action::UseColour(colour), colour != app.edit.colour));
    out.push(Sep);

    out.push(cmd(app, "model.make_submodel"));
    if in_use {
        out.push(cmd(app, "model.extract"));
        out.push(cmd(app, "model.make_unique"));
    }
    let models = submodel_names(app);
    if !models.is_empty() {
        let rows = models.into_iter().map(|m| Row::plain(None, m.clone(), Action::MoveToModel(m), true)).collect();
        out.push(Sub { icon: Some(Icon::Extract), label: "Move to Model".into(), rows });
    }
    out.push(Sep);

    out.push(cmd(app, "edit.copy"));
    out.push(cmd(app, "edit.cut"));
    out.push(cmd(app, "model.duplicate"));
    out.push(Sep);

    let s = app.doc.session();
    let groups = s.groups_of(&sel);
    let mut select: Vec<Row> =
        groups.iter().map(|g| Row::plain(None, format!("Same Group · {g}"), Action::SelectGroup(g.clone()), true)).collect();
    select.push(cmd(app, "edit.select_all"));
    select.push(cmd(app, "edit.select_none"));
    out.push(Sub { icon: Some(Icon::Cursor), label: "Select".into(), rows: select });
    out.push(cmd(app, "model.group"));
    if !groups.is_empty() {
        out.push(cmd(app, "model.ungroup"));
    }
    out.push(cmd(app, "edit.hide"));
    out.push(cmd(app, "edit.delete"));
    out
}

fn empty_rows(app: &mut BrickMotionApp) -> Vec<Row> {
    use Row::{Separator as Sep, Sub};
    let mut views: Vec<Row> =
        ["view.front", "view.back", "view.left", "view.right", "view.top", "view.bottom"].into_iter().map(|id| cmd(app, id)).collect();
    views.push(Sep);
    let ortho = app.ctx().orthographic;
    let mut ortho_row = cmd(app, "view.orthographic");
    if let Row::Item { label, checked, .. } = &mut ortho_row {
        *label = "Orthographic".into();
        *checked = Some(ortho);
    }
    views.push(ortho_row);
    views.push(cmd(app, "view.home"));
    vec![
        cmd(app, "edit.paste"),
        cmd(app, "edit.select_all"),
        cmd(app, "edit.show_all"),
        Sep,
        cmd(app, "view.fit"),
        Sub { icon: Some(Icon::ViewFront), label: "View".into(), rows: views },
        Sep,
        cmd(app, "model.add_part"),
        cmd(app, "model.new_submodel"),
    ]
}

/// Submodel names a piece can move into: those the model uses, but not the one being edited.
fn submodel_names(app: &BrickMotionApp) -> Vec<String> {
    let s = app.doc.session();
    let focused = s.focused();
    let mut names: Vec<String> =
        s.outline().into_iter().filter(|r| !r.unused).map(|r| r.def).filter(|d| !d.is_empty() && *d != focused).collect();
    names.sort();
    names.dedup();
    names
}

/// Draws `rows`; the chosen row's action, if any.
pub fn draw(ui: &mut Ui, t: &crate::theme::Theme, rows: &[Row]) -> Option<Action> {
    menu::prepare_width(ui, 240.0);
    let mut chosen = None;
    draw_rows(ui, t, rows, &mut chosen);
    chosen
}

fn draw_rows(ui: &mut Ui, t: &crate::theme::Theme, rows: &[Row], chosen: &mut Option<Action>) {
    for row in rows {
        match row {
            Row::Header { title, subtitle } => menu::header(ui, t, title, Some(subtitle)),
            Row::Section(s) => menu::section(ui, t, s),
            Row::Separator => menu::separator(ui, t),
            Row::Item { icon, label, keys, action, enabled, danger, checked } => {
                let hit = if let Some(on) = checked {
                    menu::item_check(ui, t, label, *on, *enabled)
                } else if *danger {
                    menu::item_destructive(ui, t, *icon, label, *enabled)
                } else {
                    menu::item(ui, t, *icon, label, keys.as_deref(), *enabled)
                };
                if hit {
                    *chosen = Some(action.clone());
                }
            }
            Row::Sub { icon, label, rows } => menu::submenu(ui, t, *icon, label, |ui| draw_rows(ui, t, rows, chosen)),
        }
    }
}

/// Does what a chosen row says.
pub fn apply(app: &mut BrickMotionApp, action: Action) {
    let s = app.doc.session();
    match action {
        Action::Run(id) => {
            run(app, id);
        }
        Action::MoveToStep(i) => {
            let sel = s.selection();
            let c = s.move_to_step(&sel, i);
            app.edited(c);
        }
        Action::MoveToModel(name) => {
            let sel = s.selection();
            let c = s.move_to_model(&sel, &name);
            app.edited(c);
        }
        Action::SelectGroup(g) => s.select_group(&g),
        Action::UseColour(c) => app.edit.colour = c,
        Action::OpenSubmodel(path) => app.focus_submodel(&path),
        Action::TurnWaiting(piece, deg) => {
            let c = s.turn_waiting_part(piece, deg);
            app.edited(c);
        }
    }
}

/// Shows the menu for the last right-click on `resp`, and runs what is chosen.
pub fn show(app: &mut BrickMotionApp, resp: &egui::Response) {
    let Some(target) = app.viewport.context_target else { return };
    let t = app.theme;
    let mut chosen = None;
    let open = resp.context_menu(|ui| {
        let rows = rows(app, target);
        chosen = draw(ui, &t, &rows);
    });
    if open.is_none() && chosen.is_none() {
        app.viewport.context_target = None;
    }
    if let Some(a) = chosen {
        app.viewport.context_target = None;
        apply(app, a);
    }
}
