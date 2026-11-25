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
  /// The focused model's Camera track keys, by time: the Build's and the Keyframes timeline's.
  private(set) var buildCameraKeys: [bmapp.CameraTrackKey] = []
  private(set) var timelineCameraKeys: [bmapp.CameraTrackKey] = []
  /// The camera key or move the Camera inspector shows.
  var cameraSelection: CameraSelection?
  func cameraKeys(_ clock: bmapp.CameraClock) -> [bmapp.CameraTrackKey] { clock == .Build ? buildCameraKeys : timelineCameraKeys }
  /// Filters the tree by name; a match keeps its ancestors.
  var outlineQuery = "" { didSet { if outlineQuery != oldValue { filter() } } }
  var importing = false
  /// Rows shown open; "root" starts open.
  var expanded: Set<String> = ["root"]
  /// The rows selected in the tree (their pieces are the selection while it lasts).
  var selectedRows: Set<String> = []
  /// The row being renamed in place.
  var renaming: String?
  var sidebarTab = SidebarTab.models
  var modelPartsExpanded = true
  private var expandedPartsSteps: [String: Set<Int>] = [:]
  private(set) var partsSelection: Set<UInt32> = []
  var partsQuery = "" { didSet { if partsQuery != oldValue { resetPartsResults() } } }
  var partsCategory: String? { didSet { if partsCategory != oldValue { resetPartsResults() } } }
  var browsedPart: LibraryPart?
  var partsScrollTarget: String?
  var partsPages = 1
  enum PartsCollection: String, CaseIterable { case frequent = "Frequent", common = "Common", recent = "Recent" }
  var partsCollection = PartsCollection.common {
    didSet { if partsCollection != oldValue { resetPartsResults() } }
  }
  var partColour: Int32 = 71 { didSet { viewport?.placement.chooseColour(partColour) } }
  var partTurns = 0
  var partMirrored = false
  var partReferenceHints = false
  var refusedEdit: String?
  let assemblyReview = AssemblyReview()
  let animation = AnimationWorkspace()
  let recorder = ViewportRecorder()
  var showJoints = false { didSet { assemblyReview.update(self); viewport?.updateEditorOverlays() } }
  /// The step selected in the Steps pane, and the one its editor is open on.
  var selectedStep: Int?
  /// The inspector's tab; it follows the selection (one piece: Part, several: Selection) unless
  /// Submodel was chosen.
  var inspectorTab = InspectorTab.selection
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
  @ObservationIgnored private var browserItemsByStep: [Int: [bmapp.ItemRow]] = [:]
  @ObservationIgnored private var browserItemsVersion: UInt64?
  @ObservationIgnored private var browserItemsStructure: UInt64?
  @ObservationIgnored private var observer: NSObjectProtocol?

  init(document: Document) {
    self.document = document
    snapshot = document.session.snapshot()
    refresh()
    observer = NotificationCenter.default.addObserver(forName: Document.didChange, object: document, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.refresh() }
    }
  }

  isolated deinit {
    if let observer { NotificationCenter.default.removeObserver(observer) }
  }

  var context: CommandContext { CommandContext(document: document, viewport: viewport, clickedPiece: nil) }

  private func resetPartsResults() {
    partsScrollTarget = nil
    partsPages = 1
  }

  func dragItem(_ part: LibraryPart) -> PartDragItem {
    PartDragItem(part: part, colour: partColour, turns: partTurns, mirrored: partMirrored, reference: partReferenceHints)
  }

  func beginPlacement(_ part: LibraryPart) {
    browsedPart = part
    viewport?.placement.begin(part, colour: partColour, turns: partTurns, mirrored: partMirrored,
                              step: selectedStep, reference: partReferenceHints)
  }

  /// After any change: a new snapshot, and the tree and steps when the structure moved.
  func refresh() {
    let session = document.session
    // A new document has no library until it gets pieces: the table is read once there is one.
    if colors.isEmpty {
      colors = Dictionary(session.colors().map { ($0.code, $0) }, uniquingKeysWith: { a, _ in a })
    }
    let before = snapshot.selection.count
    snapshot = session.snapshot()
    let buildKeys = Array(session.cameraKeys(.Build)), timelineKeys = Array(session.cameraKeys(.Timeline))
    if !buildKeys.elementsEqual(buildCameraKeys, by: Self.sameKey) { buildCameraKeys = buildKeys }
    if !timelineKeys.elementsEqual(timelineCameraKeys, by: Self.sameKey) { timelineCameraKeys = timelineKeys }
    // the key or move shown is gone (deleted, undone, another model focused)
    if let shown = cameraSelection {
      let keys = cameraKeys(shown.clock)
      let id = shown.keyId ?? shown.moveFrom ?? ""
      if !keys.contains(where: { String($0.id) == id }) || (shown.moveFrom != nil && String(keys.last?.id ?? "") == id) {
        cameraSelection = nil
      }
    }
    let after = snapshot.selection.count
    let selection = Set(snapshot.selection)
    if partsSelection != selection { partsSelection = selection }
    if inspectorTab != .submodel && inspectorTab != .camera && inspectorTab != .look && (before == 1) != (after == 1) {
      inspectorTab = after == 1 ? .part : .selection
    }
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
    assemblyReview.update(self)
  }

  /// Shows a camera key or move in the Camera inspector.
  func showCamera(_ selection: CameraSelection) {
    cameraSelection = selection
    inspectorTab = .camera
  }

  /// Every field the lane and the inspector show, so a change to any of them redraws them.
  private static func sameKey(_ a: bmapp.CameraTrackKey, _ b: bmapp.CameraTrackKey) -> Bool {
    String(a.id) == String(b.id) && a.seconds == b.seconds && String(a.target) == String(b.target) &&
      String(a.preset) == String(b.preset) && a.user == b.user && a.azimuth == b.azimuth && a.elevation == b.elevation &&
      a.lensMm == b.lensMm && a.fitted == b.fitted && a.margin == b.margin && a.distance == b.distance && a.roll == b.roll &&
      a.focusTarget == b.focusTarget && a.focus == b.focus && a.blur == b.blur &&
      a.point.x == b.point.x && a.point.y == b.point.y && a.point.z == b.point.z
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
    // The session's selection is set (and recorded as the rows') before anyone hears of it, so
    // the refresh the change notice runs keeps the rows selected.
    document.session.select(ViewportView.list(pieces.sorted()), .Replace)
    rowPieces = Array(document.session.selection())
    if let viewport { viewport.viewStateChanged() } else { document.postChange() }
  }

  /// The submodel names from the root down to `row`: the focus that edits it alone.
  func path(to row: OutlineNode) -> [String] {
    path(from: rows.firstIndex { String($0.id) == row.id })
  }

  private func path(from index: Int?) -> [String] {
    var out: [String] = []
    var i = index
    while let k = i {
      let def = String(rows[k].def)
      if !def.isEmpty { out.insert(def, at: 0) }
      i = rows[k].parent >= 0 ? Int(rows[k].parent) : nil
    }
    return out
  }

  /// A shared definition only needs one video, even if several of its uses are selected.
  func submodelVideoTargets(for ids: Set<String>? = nil) -> [ModelVideoTarget] {
    var definitions: Set<String> = []
    return rows.enumerated().compactMap { index, row in
      let definition = String(row.def)
      guard !definition.isEmpty, row.pieces > 0, ids?.contains(String(row.id)) != false,
            definitions.insert(definition).inserted else { return nil }
      return ModelVideoTarget(title: displayName(String(row.name)), path: path(from: index))
    }
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

  func browserItems(of step: Int) -> [bmapp.ItemRow] {
    let version = snapshot.version
    let structure = document.session.structureVersion()
    if browserItemsVersion != version || browserItemsStructure != structure {
      browserItemsVersion = version
      browserItemsStructure = structure
      browserItemsByStep.removeAll()
    }
    if let rows = browserItemsByStep[step] { return rows }
    let rows = items(of: step)
    browserItemsByStep[step] = rows
    return rows
  }

  private var partsScope: String { String(snapshot.focus) }

  func partsStepIsExpanded(_ step: Int) -> Bool {
    expandedPartsSteps[partsScope, default: [0]].contains(step)
  }

  func togglePartsStep(_ step: Int) {
    let scope = partsScope
    if partsStepIsExpanded(step) { expandedPartsSteps[scope, default: [0]].remove(step) }
    else { expandedPartsSteps[scope, default: [0]].insert(step) }
  }

  func setPartsStepsExpanded(_ expanded: Bool) {
    expandedPartsSteps[partsScope] = expanded ? Set(steps.indices) : []
  }

  var partsDestinations: [String] {
    let scope = partsScope
    var seen = Set<String>()
    var inside = Set<Int>()
    return rows.enumerated().compactMap { index, row in
      let name = String(row.def)
      let descendant = scope.isEmpty || inside.contains(Int(row.parent))
      if descendant || name == scope { inside.insert(index) }
      guard descendant, !name.isEmpty, !row.unused, name != scope, seen.insert(name).inserted else { return nil }
      return name
    }
  }

  @discardableResult func extractParts(of item: bmapp.ItemRow) -> Bool {
    guard item.submodel, let piece = item.pieces.first else { return false }
    return context.perform { $0.extract(piece) }
  }

  /// The library's colours by code, read once.
  @ObservationIgnored private(set) var colors: [Int32: bmapp.ColorInfo] = [:]

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
    selectedRows = []
    document.session.select(document.session.piecesOfStep(k), .Replace)
    stepPieces = Array(document.session.selection())
    selectedStep = k
    if let viewport { viewport.viewStateChanged() } else { document.postChange() }
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
