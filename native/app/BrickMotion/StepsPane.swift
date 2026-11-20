// The Steps pane: the steps of the model being edited. A click selects a step's pieces, a drag
// reorders, a double click edits the step in a popover.
import AppKit
import BMApp
import SwiftUI

struct StepsPane: View {
  @Bindable var model: DocumentModel

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text("Build Steps").font(.subheadline.weight(.semibold))
        Text(model.steps.count.formatted()).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
        Spacer()
        Button("Show All", systemImage: "eye") {
          model.select(step: nil)
          model.animation.rest()
          Registry.command("edit.showAll")?.run(model.context)
        }
        .labelStyle(.iconOnly)
        .buttonStyle(.borderless)
        .help("Show every step and reveal hidden parts")
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      if model.steps.contains(where: { $0.items > 32 && $0.title.empty() && $0.notes.empty() && !$0.pinOrder && $0.pauseAfter == 0 }) {
        Button {
          model.animation.regenerateSteps()
        } label: {
          Label("Split into Smaller Steps", systemImage: "list.bullet.indent")
            .font(.caption.weight(.medium))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .controlSize(.small)
        .help("Use the planned build order to split long steps. Named, timed and pinned steps are preserved.")
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
      }
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
}

private struct StepRowView: View {
  let step: bmapp.StepRow
  let model: DocumentModel
  @State private var showsSubmodels = false

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
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Step \(k + 1)\(title.isEmpty ? "" : ", \(title)"), \(step.pieces) parts")
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
      if step.submodels > 0 {
        Button { showsSubmodels.toggle() } label: {
          Image(systemName: "square.stack.3d.up").font(.callout)
        }
        .buttonStyle(.borderless)
        .labelStyle(.iconOnly)
        .help("Browse submodels in step \(k + 1)")
        .accessibilityLabel("Submodels in step \(k + 1)")
        .popover(isPresented: $showsSubmodels, arrowEdge: .trailing) {
          SubmodelSteps(names: Set(model.items(of: k).filter(\.submodel).map { String($0.name) }).sorted(), model: model) { name, step in
            showsSubmodels = false
            model.context.refocus(model.focusPath + [name])
            model.select(step: step)
          }
        }
      }
    }
    .padding(.vertical, 2)
    .popover(isPresented: Binding(get: { model.editingStep == k }, set: { if !$0 && model.editingStep == k { model.editingStep = nil } }),
             arrowEdge: .trailing) {
      StepEditor(editor: StepEditorModel(model: model, step: k))
    }
    .accessibilityActions {
      if step.submodels > 0 {
        Button("Browse Submodel Steps") { showsSubmodels = true }
      }
    }
  }
}

private struct SubmodelSteps: View {
  let names: [String]
  let model: DocumentModel
  let open: (String, Int) -> Void

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        ForEach(names, id: \.self) { name in
          let steps = Array(model.document.session.stepsOfSubmodel(std.string(name)))
          VStack(alignment: .leading, spacing: 4) {
            Label(displayName(name), systemImage: "cube")
              .font(.headline)
            ForEach(steps, id: \.index) { step in
              let number = Int(step.index) + 1
              Button { open(name, number - 1) } label: {
                HStack(spacing: 8) {
                  Text(number.formatted()).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                  Text(step.title.empty() ? "Step \(number)" : String(step.title))
                    .lineLimit(1)
                  Spacer()
                  Text("\(step.pieces) parts").font(.caption).foregroundStyle(.secondary)
                  Image(systemName: "arrow.up.right").font(.caption2).foregroundStyle(.secondary)
                }
                .contentShape(.rect)
              }
              .buttonStyle(.borderless)
              .help("Open this step in \(displayName(name))")
            }
          }
        }
      }
      .padding(14)
    }
    .frame(width: 256)
    .frame(maxHeight: 300)
    .fixedSize(horizontal: false, vertical: true)
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
    Button("Play This Step") {
      (model.viewport?.window?.windowController as? WindowController)?.setAnimateMode(true, plan: false)
      model.animation.tab = .build
      model.animation.play(step: k)
    }
    Menu("Preview Step") {
      Button("Assembled") { preview(.Assembled) }
      Button("Separated") { preview(.Separated) }
      Button("Laid Out") { preview(.LaidOut) }
      Button("Exploded") { preview(.Exploded) }
    }
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

  private func preview(_ mode: bmapp.AssemblyPreview) {
    (model.viewport?.window?.windowController as? WindowController)?.setAnimateMode(true, plan: false)
    model.animation.tab = .build
    model.animation.arrange(step: k, mode: mode)
  }
}
