//! Safe types for build steps, step items and editorial step fields.

#[derive(Clone, Debug, PartialEq)]
pub struct StepRow {
    pub index: usize,
    pub title: String,
    pub notes: String,
    pub pause_after: f64,
    pub pin_order: bool,
    pub automatic: bool,
    pub items: usize,
    pub pieces: usize,
    pub submodels: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ItemRow {
    pub item: u64,
    pub name: String,
    pub description: String,
    pub color_name: String,
    pub group: String,
    pub color: i32,
    pub submodel: bool,
    pub step: usize,
    pub index: usize,
    pub pieces: Vec<u32>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct StepFields {
    pub title: String,
    pub notes: String,
    pub pause_after: f64,
    pub pin_order: bool,
}
