// The Models pane: the model's tree of submodel uses, a filter, and the parts of the model being
// edited by step. A click selects a row's pieces; a double click or Return edits its submodel
// alone; a row dropped on another moves into that submodel.
import AppKit
import BMApp
import SwiftUI

struct ModelsPane: View {
  @Bindable var model: DocumentModel
  @State private var partsOpen = true

  var body: some View {
    VStack(spacing: 0) {
      FilterField(text: $model.outlineQuery)
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
      List(selection: Binding(get: { model.selectedRows }, set: { model.select(rows: $0) })) {
        ForEach(model.outline) { OutlineNodeView(node: $0, model: model) }
      }
      .listStyle(.sidebar)
      .contextMenu(forSelectionType: String.self) { ids in
        RowMenu(ids: ids, model: model)
      } primaryAction: { ids in
        if let id = ids.first, let row = model.row(id) { model.open(row: row) }
      }
      .overlay {
        if model.outline.isEmpty && !model.outlineQuery.isEmpty {
          ContentUnavailableView.search(text: model.outlineQuery)
        }
      }
      Divider()
      DisclosureGroup(isExpanded: $partsOpen) {
        PartsByStep(model: model)
          .frame(minHeight: 120, maxHeight: 280)
      } label: {
        Text("Parts in \(displayName(model.snapshot.focus.empty() ? String(model.document.session.title()) : String(model.snapshot.focus)))")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(.secondary)
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
    }
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

/// One row and, open, the rows below it.
private struct OutlineNodeView: View {
  let node: OutlineNode
  let model: DocumentModel

  var body: some View {
    if let children = node.children {
      DisclosureGroup(isExpanded: Binding(
        get: { model.expanded.contains(node.id) || !model.outlineQuery.isEmpty },
        set: { open in if open { model.expanded.insert(node.id) } else { model.expanded.remove(node.id) } })) {
        ForEach(children) { OutlineNodeView(node: $0, model: model) }
      } label: {
        RowLabel(node: node, model: model)
      }
    } else {
      RowLabel(node: node, model: model)
    }
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
      }
    } icon: {
      Image(systemName: node.id == "root" ? "cube.fill" : row.unused ? "cube.transparent" : "cube")
    }
    .badge(Int(row.pieces))
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
      content.dropDestination(for: String.self) { ids, _ in drop(ids) }
    } else {
      content.draggable(node.id).dropDestination(for: String.self) { ids, _ in drop(ids) }
    }
  }
  private func drop(_ ids: [String]) -> Bool {
    guard let id = ids.first, !node.row.def.empty() else { return false }
    model.move(rowId: id, onto: node)
    return true
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
    if let one {
      Button("Open") { model.open(row: one) }
      Button("Show and Fit") { model.showAndFit(row: one) }
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

/// The steps of the model being edited, each with its items. A stack, not a List: a second table
/// sized by its disclosure makes AppKit lay it out from inside its own delegate.
private struct PartsByStep: View {
  let model: DocumentModel

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 2) {
        ForEach(model.steps, id: \.index) { step in
          StepHeader(step: step, model: model)
            .padding(.top, step.index == 0 ? 2 : 8)
          ForEach(model.items(of: Int(step.index)), id: \.item) { item in
            ItemLine(item: item, model: model)
              .padding(.leading, 6)
          }
        }
      }
      .padding(.vertical, 4)
    }
  }
}

private struct StepHeader: View {
  let step: bmapp.StepRow
  let model: DocumentModel

  var body: some View {
    let k = Int(step.index), hidden = model.isHidden(step: k), title = String(step.title)
    HStack {
      Text(title.isEmpty ? "Step \(k + 1)" : "\(k + 1). \(title)")
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
      Spacer()
      Button { model.setHidden(step: k, !hidden) } label: {
        Image(systemName: hidden ? "eye.slash" : "eye")
      }
      .buttonStyle(.plain)
      .foregroundStyle(hidden ? .tertiary : .secondary)
      .help(hidden ? "Show this step's pieces" : "Hide this step's pieces")
      .accessibilityLabel(hidden ? "Show step \(k + 1)" : "Hide step \(k + 1)")
    }
    .contextMenu {
      Button("Select") { model.select(pieces: Array(model.document.session.piecesOfStep(k))) }
    }
  }
}

private struct ItemLine: View {
  let item: bmapp.ItemRow
  let model: DocumentModel

  var body: some View {
    let pieces = Array(item.pieces)
    HStack(spacing: 6) {
      if item.submodel {
        Image(systemName: "cube").font(.caption).foregroundStyle(.secondary)
      } else {
        let rgb = model.colors[item.color]?.rgb ?? 0x888888
        RoundedRectangle(cornerRadius: 3)
          .fill(Color(red: Double(rgb >> 16 & 0xff) / 255, green: Double(rgb >> 8 & 0xff) / 255, blue: Double(rgb & 0xff) / 255))
          .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(.separator))
          .frame(width: 12, height: 12)
      }
      VStack(alignment: .leading, spacing: 0) {
        Text(displayName(String(item.submodel || item.description.empty() ? item.name : item.description)))
          .lineLimit(1)
        if !item.submodel {
          Text("\(String(item.name)) · \(String(item.colorName))").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
      }
      Spacer(minLength: 0)
    }
    .font(.callout)
    .contentShape(.rect)
    .onTapGesture { model.select(pieces: pieces) }
    .contextMenu {
      Button("Select") { model.select(pieces: pieces) }.disabled(pieces.isEmpty)
      Button("Extract") { if let p = pieces.first { model.context.perform { $0.extract(p) } } }
        .disabled(!item.submodel || pieces.isEmpty)
      Menu("Move to Step") {
        ForEach(model.steps, id: \.index) { step in
          Button("Step \(step.index + 1)") {
            model.context.perform { $0.moveToStep(ViewportView.list(pieces), Int(step.index)) }
          }
          .disabled(Int(step.index) == Int(item.step))
        }
      }
      .disabled(pieces.isEmpty)
    }
  }
}
