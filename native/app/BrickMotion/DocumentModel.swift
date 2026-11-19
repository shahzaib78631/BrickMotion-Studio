// What the panes show of one document, for SwiftUI: the snapshot, the outline tree and the steps.
// The tree and the steps are made again only when the session's structure stamp moves, so a drag
// or a recolour never rebuilds them.
import AppKit
import BMApp
import Observation

struct OutlineNode: Identifiable {
  let id: String
  let row: bmapp.OutlineRow
  var children: [OutlineNode]?
}

/// A submodel or part name as a person reads it: no file extension, single spaces.
func displayName(_ raw: String) -> String {
  var s = raw
  for ext in [".ldr", ".dat", ".mpd"] where s.lowercased().hasSuffix(ext) { s.removeLast(ext.count) }
  return s.split(whereSeparator: { $0 == " " }).joined(separator: " ")
}

enum SidebarTab: String, CaseIterable { case models, steps, parts }

@MainActor @Observable final class DocumentModel {
  @ObservationIgnored let document: Document
  /// The viewport the panes select into and frame; set by the window controller.
  @ObservationIgnored weak var viewport: ViewportView?
  private(set) var snapshot: bmapp.Snapshot
  private(set) var outline: [OutlineNode] = []
  private(set) var steps: [bmapp.StepRow] = []
  /// Filters the tree by name; a match keeps its ancestors.
  var outlineQuery = "" { didSet { if outlineQuery != oldValue { filter() } } }
  /// Rows shown open; "root" starts open.
  var expanded: Set<String> = ["root"]
  /// The rows selected in the tree (their pieces are the selection while it lasts).
  var selectedRows: Set<String> = []
  /// The row being renamed in place.
  var renaming: String?
  var sidebarTab = SidebarTab.models
  /// The step selected in the Steps pane, and the one its editor is open on.
  var selectedStep: Int?
  var editingStep: Int?
  /// The focused model's name, then the path above it: what the breadcrumb shows.
  var focusPath: [String] {
    _ = snapshot.version  // read so a focus change redraws the breadcrumb
    return snapshot.focus.empty() ? [] : document.session.focusPath().map { String($0) }
  }
  /// How many times the tree was made from the session (selftests check a move makes none).
  @ObservationIgnored private(set) var outlineBuilds = 0

  @ObservationIgnored private var rows: [bmapp.OutlineRow] = []
  @ObservationIgnored private var tree: [OutlineNode] = []
  @ObservationIgnored private var stamp: UInt64 = .max
  @ObservationIgnored private var rowPieces: [UInt32] = []
  @ObservationIgnored private var stepPieces: [UInt32] = []
  @ObservationIgnored private var observer: NSObjectProtocol?

  init(document: Document) {
    self.document = document
    snapshot = document.session.snapshot()
    colors = Dictionary(document.session.colors().map { ($0.code, $0) }, uniquingKeysWith: { a, _ in a })
    refresh()
    observer = NotificationCenter.default.addObserver(forName: Document.didChange, object: document, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.refresh() }
    }
  }

  isolated deinit {
    if let observer { NotificationCenter.default.removeObserver(observer) }
  }

  var context: CommandContext { CommandContext(document: document, viewport: viewport, clickedPiece: nil) }

  /// After any change: a new snapshot, and the tree and steps when the structure moved.
  func refresh() {
    let session = document.session
    snapshot = session.snapshot()
    if session.structureVersion() != stamp {
      stamp = session.structureVersion()
      rows = Array(session.outline())
      steps = Array(session.steps())
      tree = Self.build(rows)
      outlineBuilds += 1
      filter()
    }
    // The tree's selection lasts while the pieces it chose are the selection.
    if !selectedRows.isEmpty && Array(snapshot.selection) != rowPieces { selectedRows = [] }
    if let k = selectedStep, k >= steps.count || Array(snapshot.selection) != stepPieces { selectedStep = nil }
    if let k = editingStep, k >= steps.count { editingStep = nil }
  }

  private static func build(_ rows: [bmapp.OutlineRow]) -> [OutlineNode] {
    var children: [[Int]] = Array(repeating: [], count: rows.count)
    var tops: [Int] = []
    for (i, r) in rows.enumerated() {
      if r.parent >= 0 && Int(r.parent) < rows.count { children[Int(r.parent)].append(i) } else { tops.append(i) }
    }
    func node(_ i: Int) -> OutlineNode {
      let below = children[i].map(node)
      return OutlineNode(id: String(rows[i].id), row: rows[i], children: below.isEmpty ? nil : below)
    }
    return tops.map(node)
  }

  private func filter() {
    let word = outlineQuery.trimmingCharacters(in: .whitespaces).lowercased()
    guard !word.isEmpty else { return outline = tree }
    func keep(_ n: OutlineNode) -> OutlineNode? {
      let below = (n.children ?? []).compactMap(keep)
      guard String(n.row.name).lowercased().contains(word) || !below.isEmpty else { return nil }
      return OutlineNode(id: n.id, row: n.row, children: below.isEmpty ? nil : below)
    }
    outline = tree.compactMap(keep)
  }

  /// Every row id with children, for Expand All.
  func expandAll() {
    func walk(_ nodes: [OutlineNode]) { for n in nodes where n.children != nil { expanded.insert(n.id); walk(n.children!) } }
    walk(tree)
  }

  func row(_ id: String) -> OutlineNode? {
    func find(_ nodes: [OutlineNode]) -> OutlineNode? {
      for n in nodes {
        if n.id == id { return n }
        if let found = find(n.children ?? []) { return found }
      }
      return nil
    }
    return find(tree)
  }

  // MARK: Actions

  /// Selects the pieces under `row` (in the model being edited); with `extend`, adds them.
  func select(row: OutlineNode, extend: Bool) {
    select(rows: extend ? selectedRows.union([row.id]) : [row.id])
  }

  /// Selects the pieces under every row in `ids`.
  func select(rows ids: Set<String>) {
    var pieces = Set<UInt32>()
    for id in ids { for p in document.session.piecesOfRow(std.string(id)) { pieces.insert(p) } }
    selectedRows = ids
    let list = pieces.sorted()
    if let viewport { viewport.select(list, .Replace) } else {
      document.session.select(ViewportView.list(list), .Replace)
      document.postChange()
    }
    rowPieces = Array(document.session.selection())
    if rowPieces != Array(snapshot.selection) { snapshot = document.session.snapshot() }
  }

  /// The submodel names from the root down to `row`: the focus that edits it alone.
  func path(to row: OutlineNode) -> [String] {
    var out: [String] = []
    var i = rows.firstIndex { String($0.id) == row.id }
    while let k = i {
      let def = String(rows[k].def)
      if !def.isEmpty { out.insert(def, at: 0) }
      i = rows[k].parent >= 0 ? Int(rows[k].parent) : nil
    }
    return out
  }

  /// Edits the row's submodel alone (the root row: the whole model).
  func open(row: OutlineNode) {
    context.refocus(path(to: row))
  }

  /// Back up one level of focus.
  func back() {
    context.refocus(Array(document.session.focusPath().map { String($0) }.dropLast()))
  }

  /// Focus on the first `depth` names of the current path (0: the whole model).
  func focus(depth: Int) {
    context.refocus(Array(document.session.focusPath().map { String($0) }.prefix(depth)))
  }

  /// Selects the row's pieces and frames them.
  func showAndFit(row: OutlineNode) {
    select(row: row, extend: false)
    viewport?.frameSelection(nil)
  }

  func rename(row: OutlineNode, to name: String) {
    renaming = nil
    let old = String(row.row.def), new = name.trimmingCharacters(in: .whitespaces)
    guard !old.isEmpty, !new.isEmpty, new != old else { return }
    context.perform { $0.renameSubmodel(std.string(old), std.string(new)) }
  }

  func delete(row: OutlineNode) {
    let name = String(row.row.def)
    guard !name.isEmpty else { return }
    context.perform { $0.deleteSubmodel(std.string(name)) }
  }

  /// A row dropped on another: the dropped use's pieces move into the target's submodel.
  func move(rowId: String, onto target: OutlineNode) {
    let into = String(target.row.def)
    guard rowId != target.id, !into.isEmpty else { return }
    let pieces = Array(document.session.piecesOfRow(std.string(rowId)))
    guard !pieces.isEmpty else { return context.refuse("Open the model that holds it to move it.") }
    context.perform { $0.moveToModel(ViewportView.list(pieces), std.string(into)) }
  }

  // MARK: Steps

  func items(of step: Int) -> [bmapp.ItemRow] { Array(document.session.stepItems(step)) }

  /// The library's colours by code, read once.
  @ObservationIgnored let colors: [Int32: bmapp.ColorInfo]

  /// Are all of the step's pieces hidden?
  func isHidden(step: Int) -> Bool {
    guard snapshot.hidden > 0 else { return false }
    let pieces = document.session.piecesOfStep(step)
    guard !pieces.isEmpty else { return false }
    let hidden = Set(document.session.hidden())
    return pieces.allSatisfy { hidden.contains($0) }
  }

  func setHidden(step: Int, _ hide: Bool) {
    let pieces = document.session.piecesOfStep(step)
    if hide { document.session.hide(pieces) } else { document.session.show(pieces) }
    viewport?.viewStateChanged() ?? document.postChange()
  }

  /// Selects a step's pieces and marks it selected in the Steps pane.
  func select(step k: Int?) {
    guard let k else { return selectedStep = nil }
    select(pieces: Array(document.session.piecesOfStep(k)))
    stepPieces = Array(document.session.selection())
    selectedStep = k
  }

  /// A drag in the Steps pane: List's offsets (the row's place before the move) to the session's.
  func moveSteps(from source: IndexSet, to destination: Int) {
    guard let from = source.first else { return }
    let to = destination > from ? destination - 1 : destination
    guard to != from else { return }
    context.perform { $0.moveStep(from, to) }
  }

  func select(pieces: [UInt32]) {
    selectedRows = []
    if let viewport { viewport.select(pieces, .Replace) } else {
      document.session.select(ViewportView.list(pieces), .Replace)
      document.postChange()
    }
  }
}
