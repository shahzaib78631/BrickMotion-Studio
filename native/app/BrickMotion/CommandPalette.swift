// ⌘K: a floating glass panel over the window that finds any command by a few letters of its
// name, plus Open <submodel> and Go to Step n. Return runs, Esc closes, ↑↓ move.
import AppKit
import BMApp
import SwiftUI

struct PaletteItem: Identifiable {
  let id: String
  let title: String
  let symbol: String?
  let shortcut: String
  /// The menu it is in, shown when another row has the same title.
  var detail = ""
  /// The registry command it runs, if it is one.
  let command: String?
  let run: @MainActor () -> Void
}

/// What the palette offers now: the registry's enabled commands (with a menu title), each
/// submodel to open, each step to go to.
@MainActor func paletteItems(_ context: CommandContext) -> [PaletteItem] {
  var out: [PaletteItem] = []
  let menuNames: [MenuPlace: String] = [.file: "File", .edit: "Edit", .select: "Select", .object: "Object", .step: "Step", .view: "View"]
  // The document's own commands (File) after the model's, so a tie goes to editing the model.
  let ordered = Registry.all.filter { $0.menu != .file } + Registry.all.filter { $0.menu == .file }
  for c in ordered where c.menu != .none && c.id != "view.palette" && c.enabled(context) {
    let title = c.titleFor?(context) ?? c.title
    out.append(PaletteItem(id: c.id, title: title, symbol: c.symbol, shortcut: c.shortcut, detail: menuNames[c.menu] ?? "", command: c.id,
                           run: { c.run(context) }))
  }
  let titles = Dictionary(grouping: out, by: \.title)
  for i in out.indices where titles[out[i].title]?.count ?? 0 < 2 { out[i].detail = "" }
  guard let session = context.session else { return out }
  var seen = Set<String>()
  let path = session.focusPath().map { String($0) }
  for row in session.outline() where !row.def.empty() {
    let name = String(row.def)
    guard seen.insert(name).inserted, name != path.last else { continue }
    out.append(PaletteItem(id: "open/" + name, title: "Open \(displayName(name))", symbol: "arrow.down.right.square", shortcut: "", command: nil,
                           run: { context.refocus(pathTo(row, session)) }))
  }
  for k in 0..<Int(session.stepCount()) {
    let title = String(session.stepFields(k).title)
    out.append(PaletteItem(id: "step/\(k)", title: title.isEmpty ? "Go to Step \(k + 1)" : "Go to Step \(k + 1): \(title)", symbol: "list.number",
                           shortcut: "", command: nil,
                           run: {
                             context.viewport?.select(Array(session.piecesOfStep(k)), .Replace)
                             context.viewport?.frameSelection(nil)
                           }))
  }
  return out
}

/// The submodel names from the root down to an outline row.
@MainActor private func pathTo(_ row: bmapp.OutlineRow, _ session: bmapp.Session) -> [String] {
  let rows = Array(session.outline())
  var out: [String] = []
  var at: Int? = rows.firstIndex { String($0.id) == String(row.id) }
  while let k = at {
    if !rows[k].def.empty() { out.insert(String(rows[k].def), at: 0) }
    at = rows[k].parent >= 0 ? Int(rows[k].parent) : nil
  }
  return out
}

/// The items whose titles hold the query's letters in order, best first: a run of consecutive
/// letters and a letter at a word's start count most. An empty query keeps `recent` first.
func paletteMatches(_ query: String, in items: [PaletteItem], recent: [String] = []) -> [PaletteItem] {
  let q = Array(query.lowercased().filter { !$0.isWhitespace })
  if q.isEmpty {
    let rank = Dictionary(recent.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
    return items.enumerated().sorted { a, b in
      (rank[a.element.id] ?? Int.max, a.offset) < (rank[b.element.id] ?? Int.max, b.offset)
    }.map(\.element)
  }
  var scored: [(PaletteItem, Int, Int)] = []
  for (order, item) in items.enumerated() {
    let t = Array(item.title.lowercased())
    var i = 0, score = 0, last = -2
    for (k, ch) in t.enumerated() where i < q.count && ch == q[i] {
      score += 1
      if k == last + 1 { score += 5 }
      if k == 0 || !(t[k - 1].isLetter || t[k - 1].isNumber) { score += 8 }
      last = k
      i += 1
    }
    guard i == q.count else { continue }
    score -= t.count / 8  // shorter titles win a tie
    scored.append((item, score, order))
  }
  return scored.sorted { ($0.1, -$0.2) > ($1.1, -$1.2) }.map(\.0)
}

// MARK: The panel

@MainActor final class CommandPalette: NSPanel {
  private static var current: CommandPalette?
  /// --snapshot's app is never active: there the palette must not close or hide for that.
  static var keepWhenInactive = false
  static let width: CGFloat = 560
  private static let recentKey = "paletteRecent"

  /// Opens the palette over `window` (closing one already open), optionally with a query.
  @discardableResult static func show(over window: NSWindow, query: String = "") -> CommandPalette {
    current?.close()
    let controller = window.windowController as? WindowController
    let context = CommandContext(document: controller?.document as? Document, viewport: controller?.viewportController.viewportView, clickedPiece: nil)
    let panel = CommandPalette(context: context, query: query)
    let f = window.frame
    panel.setFrameOrigin(NSPoint(x: f.midX - width / 2, y: f.maxY - f.height * 0.18 - panel.frame.height))
    window.addChildWindow(panel, ordered: .above)
    panel.makeKeyAndOrderFront(nil)
    current = panel
    return panel
  }

  private init(context: CommandContext, query: String) {
    super.init(contentRect: NSRect(x: 0, y: 0, width: Self.width, height: 380), styleMask: [.borderless, .nonactivatingPanel],
               backing: .buffered, defer: false)
    isFloatingPanel = true
    level = .floating
    backgroundColor = .clear
    isOpaque = false
    hasShadow = true
    hidesOnDeactivate = !Self.keepWhenInactive
    let recent = UserDefaults.standard.stringArray(forKey: Self.recentKey) ?? []
    let view = PaletteView(items: paletteItems(context), recent: recent, query: query,
                           pick: { [weak self] item in
                             self?.close()
                             UserDefaults.standard.set(Array(([item.id] + recent.filter { $0 != item.id }).prefix(8)), forKey: Self.recentKey)
                             item.run()
                           },
                           cancel: { [weak self] in self?.close() },
                           resize: { [weak self] height in self?.fit(height) })
    let host = NSHostingView(rootView: view)
    host.frame = NSRect(x: 0, y: 0, width: Self.width, height: 380)
    contentView = host
  }

  /// Grows or shrinks to its results, keeping its top edge where it is.
  func fit(_ height: CGFloat) {
    var f = frame
    guard abs(f.height - height) > 0.5 else { return }
    f.origin.y += f.height - height
    f.size.height = height
    setFrame(f, display: true)
  }

  override var canBecomeKey: Bool { true }

  override func resignKey() {
    super.resignKey()
    // Another window took the keyboard: the palette goes, as a menu would.
    if isVisible && !Self.keepWhenInactive { close() }
  }

  override func close() {
    parent?.removeChildWindow(self)
    super.close()
    if Self.current === self { Self.current = nil }
  }
}

private struct PaletteView: View {
  let items: [PaletteItem]
  let recent: [String]
  @State var query: String
  let pick: (PaletteItem) -> Void
  let cancel: () -> Void
  let resize: (CGFloat) -> Void
  @State private var index = 0
  static let field: CGFloat = 54, row: CGFloat = 34
  @FocusState private var focused: Bool

  var body: some View {
    let results = Array(paletteMatches(query, in: items, recent: recent).prefix(40))
    let height = Self.field + (results.isEmpty ? 56 : CGFloat(min(results.count, 9)) * Self.row + 12)
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        Image(systemName: "magnifyingglass").font(.title3).foregroundStyle(.secondary)
        TextField("Search commands", text: $query)
          .textFieldStyle(.plain)
          .font(.title3)
          .focused($focused)
          .onSubmit { if results.indices.contains(index) { pick(results[index]) } }
          // On the field itself: it has the keyboard and would take ↑↓ before an ancestor.
          .onKeyPress(.downArrow) { index = min(index + 1, max(results.count - 1, 0)); return .handled }
          .onKeyPress(.upArrow) { index = max(index - 1, 0); return .handled }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 14)
      Divider()
      ScrollViewReader { scroller in
        ScrollView {
          LazyVStack(spacing: 2) {
            ForEach(Array(results.enumerated()), id: \.element.id) { i, item in
              PaletteRow(item: item, chosen: i == index)
                .id(i)
                .contentShape(.rect)
                .onTapGesture { pick(item) }
            }
          }
          .padding(6)
        }
        .onChange(of: index) { scroller.scrollTo(index) }
      }
      .overlay {
        if results.isEmpty { Text("No command matches “\(query)”.").foregroundStyle(.secondary) }
      }
    }
    .frame(width: CommandPalette.width, height: height)
    .glassEffect(.regular, in: .rect(cornerRadius: 18))
    .onAppear { focused = true; resize(height) }
    .onChange(of: height) { resize(height) }
    .onChange(of: query) { index = 0 }
    .onExitCommand { cancel() }
  }
}

private struct PaletteRow: View {
  let item: PaletteItem
  let chosen: Bool

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: item.symbol ?? "command")
        .frame(width: 20)
        .foregroundStyle(chosen ? .white : .secondary)
      Text(item.title).lineLimit(1)
      if !item.detail.isEmpty {
        Text(item.detail).font(.callout).foregroundStyle(chosen ? .white.opacity(0.7) : .secondary)
      }
      Spacer()
      if !item.shortcut.isEmpty {
        Text(item.shortcut).font(.callout.monospaced()).foregroundStyle(chosen ? .white.opacity(0.85) : .secondary)
      }
    }
    .foregroundStyle(chosen ? .white : .primary)
    .padding(.horizontal, 10)
    .frame(height: 32)
    .background(chosen ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.clear), in: .rect(cornerRadius: 8))
    .accessibilityLabel(item.shortcut.isEmpty ? item.title : "\(item.title), \(item.shortcut)")
  }
}
