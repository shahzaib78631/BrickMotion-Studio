//! Owned copies of the engine's lists: what an edit changed, the models outline, the snapshot the
//! panes read, and the library's colours.

/// What an edit, undo or redo changed.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Changed {
    /// Items were added, removed or regrouped.
    pub structure: bool,
    /// The session's version after it.
    pub version: u64,
    /// Why nothing changed, when the engine refused.
    pub refused: Option<String>,
}

/// A row of the models outline, in depth-first file order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutlineRow {
    /// "root", the use ids joined by "/", or "unused/<name>".
    pub id: String,
    /// The submodel it shows; "" for the whole model.
    pub def: String,
    pub name: String,
    pub group: String,
    pub depth: u32,
    /// The row above it in the tree.
    pub parent: Option<usize>,
    /// Parts under it, at any depth.
    pub pieces: usize,
    /// How many times its submodel is used.
    pub uses: usize,
    /// Used more than once: editing it changes every use.
    pub shared: bool,
    pub unused: bool,
}

/// One selected piece, described.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PieceInfo {
    pub piece: u32,
    pub part: String,
    pub description: String,
    pub color_name: String,
    /// Outermost first, joined by "/"; "" in the root model.
    pub submodel_path: String,
    pub color: i32,
    /// From 0.
    pub step: i32,
    pub in_shared_submodel: bool,
}

/// What the panes show of a session.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Snapshot {
    pub version: u64,
    pub pieces: usize,
    /// The whole selection's size.
    pub selected: usize,
    pub hidden: usize,
    pub dirty: bool,
    /// The first 200 selected pieces.
    pub described: Vec<PieceInfo>,
}

/// A library colour.
#[derive(Debug, Clone, PartialEq)]
pub struct ColorInfo {
    pub code: i32,
    pub name: String,
    pub rgb: [u8; 3],
    pub alpha: f32,
    /// 0 solid, 1 transparent, 2 metallic, 3 other.
    pub group: i32,
}
