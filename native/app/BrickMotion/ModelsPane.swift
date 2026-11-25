// The Models pane: the model's tree of submodel uses, a filter, and the parts of the model being
// edited by step. A click selects a row's pieces; a double click or Return edits its submodel
// alone; a row dropped on another moves into that submodel.
import AppKit
import BMApp
import SwiftUI

struct ModelsPane: View {
  @Bindable var model: DocumentModel
  @FocusState private var focusedRow: String?

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        FilterField(text: $model.outlineQuery)
        if model.importing { ProgressView().controlSize(.small).accessibilityLabel("Importing") }
      }
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 2) {
          ForEach(visibleOutline) { row in outlineRow(row) }
          if model.outline.isEmpty && !model.outlineQuery.isEmpty {
            Text("No matching models")
              .font(.callout)
              .foregroundStyle(.secondary)
              .padding(6)
          }
          ModelPartsBrowser(model: model)
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 8)
      }
      if model.modelPartsExpanded && !model.partsSelection.isEmpty {
        Divider()
        HStack {
          Text("\(model.partsSelection.count) selected")
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
            .lineLimit(1)
          Spacer(minLength: 4)
          Button("Clear") { model.select(pieces: []) }
            .buttonStyle(.borderless)
            .help("Clear part selection")
          Menu("Actions") {
            ModelPartsActions(model: model, pieces: Array(model.snapshot.selection))
          }
          .menuStyle(.borderlessButton)
          .fixedSize()
          .accessibilityLabel("Selected Parts Actions")
        }
        .font(.caption)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(.bar)
      }
    }
  }
  private struct VisibleRow: Identifiable {
    let node: OutlineNode
    let depth: Int
    var id: String { node.id }
  }

  private var visibleOutline: [VisibleRow] {
    func visit(_ nodes: [OutlineNode], depth: Int) -> [VisibleRow] {
      nodes.flatMap { node in
        let row = VisibleRow(node: node, depth: depth)
        guard isExpanded(node), let children = node.children else { return [row] }
        return [row] + visit(children, depth: depth + 1)
      }
    }
    return visit(model.outline, depth: 0)
  }

  private func isExpanded(_ node: OutlineNode) -> Bool {
    model.expanded.contains(node.id) || !model.outlineQuery.isEmpty
  }

  private func outlineRow(_ row: VisibleRow) -> some View {
    let node = row.node
    let selected = model.selectedRows.contains(node.id)
    return HStack(spacing: 4) {
      if node.children != nil {
        Button {
          if !model.expanded.insert(node.id).inserted { model.expanded.remove(node.id) }
        } label: {
          Image(systemName: isExpanded(node) ? "chevron.down" : "chevron.right")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(.secondary)
            .frame(width: 15, height: 24)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(isExpanded(node) ? "Collapse" : "Expand") \(displayName(String(node.row.name)))")
      } else {
        Color.clear.frame(width: 15, height: 1).accessibilityHidden(true)
      }
      if model.renaming == node.id {
        RowLabel(node: node, model: model)
      } else {
        Button {
          focusedRow = node.id
          let modifiers = NSApp.currentEvent?.modifierFlags ?? []
          model.select(row: node, extend: modifiers.contains(.command) || modifiers.contains(.shift))
        } label: {
          RowLabel(node: node, model: model)
            .frame(maxWidth: .infinity, minHeight: 26, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .focused($focusedRow, equals: node.id)
        .simultaneousGesture(TapGesture(count: 2).onEnded { model.open(row: node) })
        .onKeyPress(.return) { model.open(row: node); return .handled }
        .onKeyPress(.upArrow) { moveFocus(from: node.id, by: -1) }
        .onKeyPress(.downArrow) { moveFocus(from: node.id, by: 1) }
        .onKeyPress(.leftArrow) {
          guard model.expanded.remove(node.id) != nil else { return .ignored }
          return .handled
        }
        .onKeyPress(.rightArrow) {
          guard node.children != nil else { return .ignored }
          model.expanded.insert(node.id)
          return .handled
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
      }
    }
    .padding(.leading, CGFloat(row.depth) * 12 + 3)
    .padding(.trailing, 7)
    .background(selected ? Color.accentColor.opacity(0.18) : .clear, in: .rect(cornerRadius: 6))
    .contextMenu {
      RowMenu(ids: selected ? model.selectedRows : [node.id], model: model)
    }
  }

  private func moveFocus(from id: String, by offset: Int) -> KeyPress.Result {
    let visible = visibleOutline
    guard let index = visible.firstIndex(where: { $0.id == id }),
          visible.indices.contains(index + offset) else { return .ignored }
    let next = visible[index + offset].node
    focusedRow = next.id
    model.select(row: next, extend: false)
    return .handled
  }

}

/// A search field that filters the tree by name.
private struct FilterField: View {
  @Binding var text: String
  var body: some View {
    HStack(spacing: 5) {
      Image(systemName: "line.3.horizontal.decrease").foregroundStyle(.secondary)
      TextField("Filter", text: $text)
        .textFieldStyle(.plain)
      if !text.isEmpty {
        Button { text = "" } label: { Image(systemName: "xmark.circle.fill") }
          .buttonStyle(.plain)
          .foregroundStyle(.secondary)
          .help("Clear the filter")
      }
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 5)
    .background(.quaternary.opacity(0.6), in: .rect(cornerRadius: 7))
  }
}

private struct RowLabel: View {
  let node: OutlineNode
  let model: DocumentModel

  var body: some View {
    let row = node.row
    Label {
      HStack(spacing: 5) {
        if model.renaming == node.id {
          RenameField(initial: String(row.name)) { model.rename(row: node, to: $0) } cancel: { model.renaming = nil }
        } else {
          Text(displayName(String(row.name))).lineLimit(1).truncationMode(.middle)
        }
        if row.shared {
          Image(systemName: "square.on.square")
            .font(.caption)
            .foregroundStyle(.secondary)
            .help("Used \(row.uses) times: editing it changes every use")
        }
        if row.unused {
          Text("Unused").font(.caption).foregroundStyle(.secondary)
        }
        if !row.group.empty() {
          Label(String(row.group), systemImage: "tag")
            .labelStyle(.iconOnly)
            .font(.caption)
            .foregroundStyle(.secondary)
            .help(String(row.group))
        }
        Spacer(minLength: 0)
        Text(row.pieces.formatted()).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
      }
    } icon: {
      Image(systemName: node.id == "root" ? "cube.fill" : row.unused ? "cube.transparent" : "cube")
    }
    .modifier(DragAndDrop(node: node, model: model))
    .accessibilityLabel("\(displayName(String(row.name))), \(row.pieces) parts\(row.shared ? ", shared" : "")\(row.unused ? ", unused" : "")")
  }
}

/// Use rows drag; rows of a submodel take drops.
private struct DragAndDrop: ViewModifier {
  let node: OutlineNode
  let model: DocumentModel
  func body(content: Content) -> some View {
    if node.id == "root" || node.row.unused {
      content.dropDestination(for: String.self, isEnabled: !node.row.def.empty()) { ids, _ in drop(ids) }
    } else {
      content.draggable(node.id).dropDestination(for: String.self) { ids, _ in drop(ids) }
    }
  }
  private func drop(_ ids: [String]) {
    guard let id = ids.first, !node.row.def.empty() else { return }
    model.move(rowId: id, onto: node)
  }
}

private struct RenameField: View {
  let initial: String
  let commit: (String) -> Void
  let cancel: () -> Void
  @State private var text = ""
  @FocusState private var focused: Bool

  var body: some View {
    TextField("Name", text: $text)
      .textFieldStyle(.plain)
      .focused($focused)
      .onAppear { text = initial; focused = true }
      .onSubmit { commit(text) }
      .onExitCommand { cancel() }
  }
}

/// The context menu of the selected rows (or the row clicked).
private struct RowMenu: View {
  let ids: Set<String>
  let model: DocumentModel

  var body: some View {
    let rows = ids.compactMap { model.row($0) }
    let one = rows.count == 1 ? rows.first : nil
    let targets = model.submodelVideoTargets(for: ids)
    if let one {
      Button("Open") { model.open(row: one) }
      Button("Show and Fit") { model.showAndFit(row: one) }
      Button("View Parts") {
        model.open(row: one)
        model.modelPartsExpanded = true
      }
      Button("Play Build") {
        model.open(row: one)
        if let viewport = model.viewport {
          (viewport.window?.windowController as? WindowController)?.setAnimateMode(true, plan: false)
          model.animation.tab = .build
          viewport.viewport.playRange(0, 0)
          viewport.changed()
        }
      }
      Button("Lay Out Parts") {
        model.open(row: one)
        model.viewport?.presentation.flatLay()
      }
      Button("Import into Model…") { ModelImportSheet.show(in: model, into: String(one.row.def)) }
        .disabled(model.importing)
    }
    if let one, !targets.isEmpty {
      let name = String(one.row.def)
      Menu("Export") {
        Button("Video…") { VideoExportSheet.show(model.context, targets: targets) }
        Button("Standalone Project…") { SubmodelFileExport.show(model.context, name: name, format: .project) }
        Button("LDraw MPD…") { SubmodelFileExport.show(model.context, name: name, format: .ldraw) }
      }
    } else if !targets.isEmpty {
      Button(targets.count == 1 ? "Export Submodel Video…" : "Export Selected Submodel Videos…") {
        VideoExportSheet.show(model.context, targets: targets)
      }
    }
    Button("Select Pieces") { model.select(rows: ids) }.disabled(rows.isEmpty)
    Divider()
    Button("Rename…") { model.renaming = one?.id }.disabled(one.map { $0.row.def.empty() } ?? true)
    Button("New Submodel…") { Registry.command("object.newSubmodel")?.run(model.context) }
    Button("Make Submodel from Selection…") { Registry.command("object.makeSubmodel")?.run(model.context) }
      .disabled(model.snapshot.selection.count < 2)
    Divider()
    Button("Delete", role: .destructive) { if let one { model.delete(row: one) } }
      .disabled(!(one?.row.unused ?? false))
  }
}
