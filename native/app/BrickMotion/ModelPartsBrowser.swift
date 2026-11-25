import AppKit
import BMApp
import SwiftUI

/// The parts of the focused model, in the same scrolling surface as the models tree.
struct ModelPartsBrowser: View {
  let model: DocumentModel
  @State private var expandedEntries: Set<UInt64> = []

  private var name: String {
    let focus = String(model.snapshot.focus)
    return displayName(focus.isEmpty ? String(model.document.session.title()) : focus)
  }

  var body: some View {
    header
    if model.modelPartsExpanded {
      if model.steps.isEmpty {
        Text("No build steps").font(.callout).foregroundStyle(.secondary)
      }
      ForEach(rows) { row in
        browserRow(row)
      }
    }
  }

  private var rows: [Row] {
    var result: [Row] = []
    for step in model.steps {
      result.append(.step(step))
      let index = Int(step.index)
      guard model.partsStepIsExpanded(index) else { continue }
      let entries = Entry.group(model.browserItems(of: index))
      if entries.isEmpty { result.append(.emptyStep(index)) }
      for entry in entries {
        result.append(.entry(entry))
        if expandedEntries.contains(entry.id) && entry.items.count > 1 {
          result.append(contentsOf: entry.items.map { .instance($0, entry.title) })
        }
      }
    }
    return result
  }

  @ViewBuilder private func browserRow(_ row: Row) -> some View {
    switch row {
    case .step(let step): stepHeader(step)
    case .emptyStep:
      Text("No parts in this step")
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.leading, 22)
    case .entry(let entry): itemRow(entry)
    case .instance(let item, let title): instanceRow(item, title: title)
    }
  }

  private var header: some View {
    HStack(spacing: 2) {
      disclosure("Parts in \(name)", expanded: model.modelPartsExpanded) {
        toggleBrowser()
      }
      .font(.subheadline.weight(.semibold))
      if model.modelPartsExpanded {
        Menu {
          Button("Expand All Steps") { model.setPartsStepsExpanded(true) }
          Button("Collapse All Steps") { model.setPartsStepsExpanded(false) }
        } label: {
          Image(systemName: "ellipsis.circle")
            .font(.body)
            .frame(width: 24, height: 24)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Parts Browser Actions")
        .accessibilityLabel("Parts Browser Actions")
      }
    }
    .padding(.top, 6)
    .accessibilityElement(children: .contain)
    .accessibilityAction(named: Text(model.modelPartsExpanded ? "Collapse Parts Browser" : "Expand Parts Browser"), toggleBrowser)
  }

  private func toggleBrowser() {
    var transaction = Transaction()
    transaction.disablesAnimations = true
    withTransaction(transaction) { model.modelPartsExpanded.toggle() }
  }

  private func stepHeader(_ step: bmapp.StepRow) -> some View {
    let index = Int(step.index)
    let expanded = model.partsStepIsExpanded(index)
    let hidden = model.isHidden(step: index)
    let title = step.title.empty() ? "Step \(index + 1)" : "Step \(index + 1) · \(String(step.title))"
    return HStack(spacing: 3) {
      disclosure(title, expanded: expanded) {
        model.togglePartsStep(index)
      }
      .font(.callout.weight(.medium))
      Text(step.items.formatted())
        .font(.caption.monospacedDigit())
        .foregroundStyle(.secondary)
        .accessibilityLabel("\(step.items) \(step.items == 1 ? "item" : "items")")
      icon("checkmark.circle", title: "Select Parts in Step \(index + 1)") { model.select(step: index) }
        .disabled(step.pieces == 0)
      icon(hidden ? "eye.slash" : "eye", title: hidden ? "Show Step \(index + 1) in Viewport" : "Hide Step \(index + 1) in Viewport") {
        model.setHidden(step: index, !hidden)
      }
      .disabled(step.pieces == 0)
    }
    .padding(.leading, 3)
    .accessibilityElement(children: .contain)
    .accessibilityActions {
      Button(expanded ? "Collapse Step" : "Expand Step") { model.togglePartsStep(index) }
      if step.pieces > 0 {
        Button("Select Step Parts") { model.select(step: index) }
        Button(hidden ? "Show Step in Viewport" : "Hide Step in Viewport") { model.setHidden(step: index, !hidden) }
      }
    }
    .contextMenu {
      Button("Select Step Parts", systemImage: "checkmark.circle") { model.select(step: index) }
        .disabled(step.pieces == 0)
      Button("Frame Step in View", systemImage: "viewfinder") {
        model.select(step: index)
        model.viewport?.frameSelection(nil)
      }
      .disabled(step.pieces == 0)
      Button(expanded ? "Collapse Step" : "Expand Step") { model.togglePartsStep(index) }
      Divider()
      Button("Collapse All Steps") { model.setPartsStepsExpanded(false) }
    }

  }

  private func itemRow(_ entry: Entry) -> some View {
    let item = entry.items[0]
    let ids = entry.pieces
    let picked = model.partsSelection
    let selected = !ids.isEmpty && ids.allSatisfy(picked.contains)
    let partial = !selected && ids.contains(where: picked.contains)
    let expanded = expandedEntries.contains(entry.id)
    return Group {
      if item.submodel {
        VStack(alignment: .leading, spacing: 4) {
          Button {
            pick(ids, extending: extendingSelection)
          } label: {
            HStack(spacing: 7) {
              Image(systemName: "shippingbox")
                .foregroundStyle(.secondary)
              Text(entry.title)
                .fontWeight(.medium)
                .foregroundStyle(Color(nsColor: .labelColor))
                .lineLimit(2)
              Spacer(minLength: 0)
              selectionMark(selected: selected, partial: partial)
            }
            .font(.callout)
            .contentShape(.rect)
          }
          .buttonStyle(.plain)
          .disabled(ids.isEmpty)
          .accessibilityAddTraits(selected ? .isSelected : [])

          HStack(spacing: 6) {
            Text("\(ids.count) \(ids.count == 1 ? "part" : "parts")")
              .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Button("Open") { open(item) }
              .help("Open \(entry.title)")
              .accessibilityLabel("Open \(entry.title)")
            Button("Extract All") { model.extractParts(of: item) }
              .disabled(ids.isEmpty)
              .help("Replace this submodel use with its parts")
              .accessibilityLabel("Extract All from \(entry.title)")
          }
          .font(.caption)
          .buttonStyle(.borderless)
        }
        .padding(.vertical, 4)
        .padding(.leading, 12)
      } else {
        HStack(spacing: 5) {
          if entry.items.count > 1 {
            icon(expanded ? "chevron.down" : "chevron.right",
                 title: "\(expanded ? "Collapse" : "Expand") \(entry.title) Instances") {
              if !expandedEntries.insert(entry.id).inserted { expandedEntries.remove(entry.id) }
            }
            .frame(width: 15)
          } else {
            Color.clear.frame(width: 15, height: 1).accessibilityHidden(true)
          }
          Button {
            pick(ids, extending: extendingSelection)
          } label: {
            HStack(spacing: 7) {
              if let colour = model.colors[item.color] {
                Swatch(info: colour, size: 13)
              } else {
                RoundedRectangle(cornerRadius: 3).fill(.tertiary).frame(width: 13, height: 13)
              }
              VStack(alignment: .leading, spacing: 1) {
                Text(entry.title).font(.callout.weight(.medium)).foregroundStyle(Color(nsColor: .labelColor))
                Text(entry.detail).font(.caption).foregroundStyle(.secondary)
              }
              .lineLimit(1)
              Spacer(minLength: 0)
              if entry.items.count > 1 {
                Text("×\(entry.items.count)")
                  .font(.caption.monospacedDigit())
                  .foregroundStyle(.secondary)
              }
              selectionMark(selected: selected, partial: partial)
            }
            .frame(minHeight: 32)
            .contentShape(.rect)
          }
          .buttonStyle(.plain)
          .disabled(ids.isEmpty)
          .accessibilityLabel("\(entry.title), \(entry.detail)\(entry.items.count > 1 ? ", \(entry.items.count) instances" : "")")
          .accessibilityAddTraits(selected ? .isSelected : [])
        }
      }
    }
    .padding(.horizontal, 4)
    .background(selected || partial ? Color.accentColor.opacity(selected ? 0.16 : 0.08) : .clear,
                in: .rect(cornerRadius: 6))
    .accessibilityElement(children: .contain)
    .accessibilityActions {
      if item.submodel {
        Button("Open Submodel") { open(item) }
        if !ids.isEmpty { Button("Extract All") { model.extractParts(of: item) } }
      }
    }
    .contextMenu {
      if item.submodel {
        Button("Open Submodel", systemImage: "arrow.down.right.square") { open(item) }
        Button("Extract All into \(name)", systemImage: "shippingbox.and.arrow.backward") { model.extractParts(of: item) }
          .disabled(ids.isEmpty)
        Divider()
      }
      Button(selected ? "Deselect" : "Add to Selection", systemImage: selected ? "minus.circle" : "plus.circle") {
        pick(ids, extending: true)
      }
      .disabled(ids.isEmpty)
      ModelPartsActions(model: model, pieces: ids, sourceStep: Int(item.step), modelToExclude: item.submodel ? String(item.name) : nil)
    }
  }

  private func instanceRow(_ item: bmapp.ItemRow, title: String) -> some View {
    let ids = Array(item.pieces)
    let selected = ids.contains(where: model.partsSelection.contains)
    return Button {
      pick(ids, extending: extendingSelection)
    } label: {
      HStack(spacing: 7) {
        Image(systemName: "arrow.turn.down.right").foregroundStyle(.tertiary)
        Text("Item \(item.index + 1)")
        Spacer()
        if selected { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
      }
      .font(.caption)
      .padding(.leading, 24)
      .padding(.vertical, 3)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .disabled(ids.isEmpty)
    .accessibilityLabel("\(title), item \(item.index + 1)")
    .accessibilityAddTraits(selected ? .isSelected : [])
    .contextMenu { ModelPartsActions(model: model, pieces: ids, sourceStep: Int(item.step)) }
  }

  private var extendingSelection: Bool {
    NSApp.currentEvent?.modifierFlags.contains(.command) == true
  }

  @ViewBuilder private func selectionMark(selected: Bool, partial: Bool) -> some View {
    if selected || partial {
      Image(systemName: selected ? "checkmark" : "minus")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(Color.accentColor)
    }
  }

  private func disclosure(_ title: String, expanded: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 7) {
        Image(systemName: expanded ? "chevron.down" : "chevron.right")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(.secondary)
          .frame(width: 12)
          .accessibilityHidden(true)
        Text(title).foregroundStyle(Color(nsColor: .labelColor)).lineLimit(1).truncationMode(.middle)
        Spacer(minLength: 0)
      }
      .frame(minHeight: 25)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier(title)
    .accessibilityValue(expanded ? "Expanded" : "Collapsed")
    .help("\(expanded ? "Collapse" : "Expand") \(title)")
  }

  private func icon(_ symbol: String, title: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.callout)
        .foregroundStyle(.secondary)
        .frame(width: 22, height: 24)
        .contentShape(.rect)
    }
    .buttonStyle(.borderless)
    .help(title)
    .accessibilityLabel(title)
  }

  private func open(_ item: bmapp.ItemRow) {
    model.context.refocus(model.focusPath + [String(item.name)])
  }

  private func pick(_ ids: [UInt32], extending: Bool) {
    guard extending else { model.select(pieces: ids); return }
    var selection = model.partsSelection
    if ids.allSatisfy(selection.contains) { selection.subtract(ids) }
    else { selection.formUnion(ids) }
    model.select(pieces: selection.sorted())
  }

  private enum Row: Identifiable {
    case step(bmapp.StepRow)
    case emptyStep(Int)
    case entry(Entry)
    case instance(bmapp.ItemRow, String)

    enum ID: Hashable {
      case step(Int), emptyStep(Int), entry(UInt64), instance(UInt64)
    }

    var id: ID {
      switch self {
      case .step(let step): .step(Int(step.index))
      case .emptyStep(let step): .emptyStep(step)
      case .entry(let entry): .entry(entry.id)
      case .instance(let item, _): .instance(item.item)
      }
    }
  }

  private struct Entry: Identifiable {
    struct Key: Hashable {
      let part: String
      let colour: Int32
      let group: String
    }

    var id: UInt64 { items[0].item }
    var items: [bmapp.ItemRow]
    var pieces: [UInt32] { items.flatMap { Array($0.pieces) } }
    var title: String {
      let row = items[0]
      return displayName(String(row.submodel || row.description.empty() ? row.name : row.description))
    }
    var detail: String {
      let row = items[0]
      if row.submodel { return "Submodel · \(row.pieces.count) \(row.pieces.count == 1 ? "part" : "parts")" }
      return [displayName(String(row.name)), String(row.colorName), String(row.group)]
        .filter { !$0.isEmpty }
        .joined(separator: " · ")
    }

    static func group(_ rows: [bmapp.ItemRow]) -> [Self] {
      var entries: [Self] = []
      var indexes: [Key: Int] = [:]
      for row in rows {
        if row.submodel {
          entries.append(Self(items: [row]))
        } else {
          let key = Key(part: String(row.name), colour: row.color, group: String(row.group))
          if let index = indexes[key] { entries[index].items.append(row) }
          else {
            indexes[key] = entries.count
            entries.append(Self(items: [row]))
          }
        }
      }
      return entries
    }
  }
}
