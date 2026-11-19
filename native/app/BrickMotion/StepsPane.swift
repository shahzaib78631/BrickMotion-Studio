// The Steps pane: the steps of the model being edited. A click selects a step's pieces, a drag
// reorders, a double click edits the step in a popover.
import AppKit
import BMApp
import SwiftUI

struct StepsPane: View {
  @Bindable var model: DocumentModel

  var body: some View {
    List(selection: Binding(get: { model.selectedStep }, set: { model.select(step: $0) })) {
      ForEach(model.steps, id: \.index) { step in
        StepRowView(step: step, model: model).tag(Int(step.index))
      }
      .onMove { model.moveSteps(from: $0, to: $1) }
    }
    .listStyle(.sidebar)
    .contextMenu(forSelectionType: Int.self) { ids in
      if let k = ids.first { StepMenu(k: k, model: model) }
    } primaryAction: { ids in
      model.editingStep = ids.first
    }
    .overlay {
      if model.steps.isEmpty { ContentUnavailableView("No Steps", systemImage: "list.number") }
    }
  }
}

private struct StepRowView: View {
  let step: bmapp.StepRow
  let model: DocumentModel

  var body: some View {
    let k = Int(step.index), title = String(step.title)
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      VStack(alignment: .leading, spacing: 1) {
        HStack(spacing: 5) {
          Text("Step \(k + 1)").fontWeight(.semibold)
          if !title.isEmpty { Text(title).lineLimit(1).truncationMode(.tail) }
        }
        HStack(spacing: 5) {
          Text("\(step.items) \(step.items == 1 ? "item" : "items") · \(step.pieces) \(step.pieces == 1 ? "part" : "parts")")
          if step.automatic { Text("auto") }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
      }
      Spacer(minLength: 4)
      if step.pauseAfter > 0 {
        Label(step.pauseAfter.formatted(.number.precision(.fractionLength(0...1))) + " s", systemImage: "pause.circle")
          .labelStyle(.titleAndIcon)
          .font(.caption)
          .foregroundStyle(.secondary)
          .help("Pauses after this step")
      }
      if step.pinOrder {
        Image(systemName: "pin.fill").font(.caption).foregroundStyle(.secondary).help("Pieces go in in this order")
      }
    }
    .padding(.vertical, 2)
    .popover(isPresented: Binding(get: { model.editingStep == k }, set: { if !$0 && model.editingStep == k { model.editingStep = nil } }),
             arrowEdge: .trailing) {
      StepEditor(editor: StepEditorModel(model: model, step: k))
    }
    .accessibilityLabel("Step \(k + 1)\(title.isEmpty ? "" : ", \(title)"), \(step.pieces) parts")
  }
}

/// A step's context menu. The step's own commands act on it whether or not it is selected.
private struct StepMenu: View {
  let k: Int
  let model: DocumentModel

  private func title(_ id: String, _ fallback: String) -> String { Registry.command(id)?.title ?? fallback }

  var body: some View {
    let session = model.document.session
    let chosen = Array(model.snapshot.selection)
    let mine = Set(session.piecesOfStep(k))
    Button("Select Pieces") { model.select(step: k) }
    Divider()
    Button(title("step.insertBefore", "Insert Step Before")) { model.context.perform { $0.insertStep(k) } }
    Button(title("step.insertAfter", "Insert Step After")) { model.context.perform { $0.insertStep(k + 1) } }
    Divider()
    Button(title("step.split", "Split Step at Selection")) { model.context.perform { $0.splitStep(k, ViewportView.list(chosen)) } }
      .disabled(chosen.isEmpty || !chosen.allSatisfy { mine.contains($0) })
    Button(title("step.mergeNext", "Merge with Next Step")) { model.context.perform { $0.mergeSteps(k) } }
      .disabled(k + 1 >= model.steps.count)
    Button("Gather Selection Here") { model.context.perform { $0.moveToStep(ViewportView.list(chosen), k) } }
      .disabled(chosen.isEmpty)
    Toggle(title("step.pinOrder", "Pin Order"), isOn: Binding(get: { session.stepFields(k).pinOrder }, set: { on in
      var f = session.stepFields(k)
      f.pinOrder = on
      model.context.perform { $0.setStepFields(k, f, false) }
    }))
    Divider()
    Button("Edit…") { model.editingStep = k }
    Button(title("step.delete", "Delete Step"), role: .destructive) { model.context.perform { $0.deleteStep(k) } }
      .disabled(model.steps.count <= 1)
  }
}
