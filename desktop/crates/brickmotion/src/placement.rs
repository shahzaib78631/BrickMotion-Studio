//! Live snapping placement controller: follows the pointer, turns, cycles grips, and commits.
use bm::library::PartMatch;
use bm::placement::{PlacementInput, PlacementPreview, PlacementState};
use bm::{Session, Vec2, Viewport};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Placed {
    Done,
    Refused(String),
}

#[derive(Debug)]
pub struct Placement {
    pub part: PartMatch,
    input: PlacementInput,
    at: Vec2,
    request: u64,
    generation: u64,
    version: u64,
    step: Option<usize>,
    awaiting: bool,
    pub state: PlacementState,
    pub reason: String,
    pub grip_count: u32,
    auto_grip: u32,
}

impl Placement {
    pub fn begin(
        part: PartMatch,
        colour: i32,
        collision: bool,
        step: Option<usize>,
        session: &Session,
        vp: &mut Viewport,
        at: Vec2,
    ) -> Placement {
        vp.show_rest();
        let input = PlacementInput {
            part: part.name.clone(),
            color: colour,
            collision,
            ..Default::default()
        };
        let request = vp.preview_part(&input, at);
        Placement {
            part,
            input,
            at,
            request,
            generation: session.generation(),
            version: session.version(),
            step,
            awaiting: false,
            state: PlacementState::Preparing,
            reason: String::new(),
            grip_count: 0,
            auto_grip: 0,
        }
    }

    pub fn pointer(&mut self, vp: &mut Viewport, at: Vec2, free: bool) {
        // After a click the clicked pose is the one placed (Swift: `awaitingCommit`).
        if self.awaiting {
            return;
        }
        let snap = !free;
        if (at.x - self.at.x).abs() <= 0.25 && (at.y - self.at.y).abs() <= 0.25 && self.input.snap == snap {
            return;
        }
        self.at = at;
        self.input.snap = snap;
        self.request = vp.preview_part(&self.input, at);
    }

    pub fn turn(&mut self, vp: &mut Viewport) {
        if self.awaiting {
            return;
        }
        self.input.turns = (self.input.turns + 1) % 4;
        self.request = vp.preview_part(&self.input, self.at);
    }

    pub fn cycle_grip(&mut self, vp: &mut Viewport, back: bool) {
        if self.grip_count <= 1 || self.awaiting {
            return;
        }
        let base = if self.input.grip < 0 { self.auto_grip } else { self.input.grip as u32 };
        let next = if back {
            (base + self.grip_count - 1) % self.grip_count
        } else {
            (base + 1) % self.grip_count
        };
        self.input.grip = next as i32;
        self.request = vp.preview_part(&self.input, self.at);
    }

    pub fn set_colour(&mut self, vp: &mut Viewport, colour: i32) {
        if !self.awaiting && self.input.color != colour {
            self.input.color = colour;
            self.request = vp.preview_part(&self.input, self.at);
        }
    }

    /// Follows the K toggle while placing.
    pub fn set_collision(&mut self, vp: &mut Viewport, on: bool) {
        if !self.awaiting && self.input.collision != on {
            self.input.collision = on;
            self.request = vp.preview_part(&self.input, self.at);
        }
    }

    pub fn accept(&mut self) {
        self.awaiting = true;
    }

    /// True if the model changed under this live placement.
    pub fn stale(&self, session: &Session) -> bool {
        session.generation() != self.generation || session.version() != self.version
    }

    pub fn poll(&mut self, vp: &Viewport, session: &Session) -> Option<Placed> {
        self.poll_with(vp.placement_preview(), session)
    }

    /// Applies one engine preview snapshot; commits when `awaiting` matches this request.
    pub fn poll_with(&mut self, preview: PlacementPreview, session: &Session) -> Option<Placed> {
        self.state = preview.state;
        self.reason = preview.reason;
        self.grip_count = preview.grip_count;
        if preview.state == PlacementState::Snapped {
            self.auto_grip = preview.grip;
        }
        if self.awaiting && preview.request == self.request {
            self.awaiting = false;
            if preview.state.is_placeable() {
                let c = session.place_part(
                    &self.input.part,
                    self.input.color,
                    &preview.pose,
                    self.step,
                    None,
                    preview.generation,
                    preview.version,
                );
                return match c.refused {
                    None => Some(Placed::Done),
                    Some(why) => {
                        self.state = PlacementState::Unavailable;
                        self.reason = why.clone();
                        Some(Placed::Refused(why))
                    }
                };
            }
        }
        None
    }

    pub fn state_word(&self) -> &'static str {
        match self.state {
            PlacementState::Snapped => "Snapped",
            PlacementState::Free => "Free",
            PlacementState::Reference => "Reference",
            PlacementState::Blocked => "Blocked",
            PlacementState::Preparing => "Preparing",
            PlacementState::Unavailable => "Unavailable",
            PlacementState::Inactive => "Placing",
        }
    }

    pub fn status_text(&self) -> String {
        if !self.reason.is_empty() && matches!(self.state, PlacementState::Blocked | PlacementState::Unavailable) {
            format!("{}: {}", self.state_word(), self.reason)
        } else {
            self.state_word().to_owned()
        }
    }

    #[doc(hidden)]
    pub fn turns(&self) -> i32 {
        self.input.turns
    }

    #[doc(hidden)]
    pub fn request(&self) -> u64 {
        self.request
    }

    #[doc(hidden)]
    pub fn collision(&self) -> bool {
        self.input.collision
    }

    #[doc(hidden)]
    pub fn awaiting(&self) -> bool {
        self.awaiting
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");

    #[test]
    fn return_does_nothing_unless_placeable() {
        let mut s = Session::new();
        s.open(Path::new(HELI)).unwrap();
        let n = s.piece_count();
        let part = PartMatch { name: "3001.dat".into(), description: "Brick 2 x 4".into(), category: "Brick".into() };
        let mut p = Placement {
            part,
            input: PlacementInput { part: "3001.dat".into(), color: 4, ..Default::default() },
            at: Vec2::new(100.0, 100.0),
            request: 7,
            generation: s.generation(),
            version: s.version(),
            step: None,
            awaiting: false,
            state: PlacementState::Preparing,
            reason: String::new(),
            grip_count: 0,
            auto_grip: 0,
        };

        for state in [PlacementState::Blocked, PlacementState::Unavailable] {
            p.accept();
            let preview = PlacementPreview {
                state,
                request: 7,
                generation: s.generation(),
                version: s.version(),
                reason: "Collides".into(),
                ..Default::default()
            };
            assert_eq!(p.poll_with(preview, &s), None);
            assert!(!p.awaiting(), "awaiting should be cleared after non-placeable answer");
            assert_eq!(s.piece_count(), n);
        }
    }
}
