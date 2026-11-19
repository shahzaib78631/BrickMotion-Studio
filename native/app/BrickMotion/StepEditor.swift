// The step editor, a popover from a step's Edit… or a double click: title, notes, the pause
// after it, and the order its pieces go in. Typing commits after a short rest, all of one
// editing session growing one undo step that closes when the popover does.
import AppKit
import BMApp
import Observation
import SwiftUI

@MainActor @Observable final class StepEditorModel {
  @ObservationIgnored let model: DocumentModel
  let step: Int
  var title: String { didSet { if title != oldValue { schedule() } } }
  var notes: String { didSet { if notes != oldValue { schedule() } } }
  var pauseAfter: Double { didSet { if pauseAfter != oldValue { commit() } } }
  @ObservationIgnored private var pending: Task<Void, Never>?
  @ObservationIgnored private var dirty = false

  init(model: DocumentModel, step: Int) {
    self.model = model
    self.step = step
    let f = model.document.session.stepFields(step)
    title = String(f.title)
    notes = String(f.notes)
    pauseAfter = f.pauseAfter
  }

  private var session: bmapp.Session { model.document.session }

  /// Commits after 0.4 s without typing.
  private func schedule() {
    dirty = true
    pending?.cancel()
    pending = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(400))
      if !Task.isCancelled { self?.commit() }
    }
  }

  /// Writes the fields now, growing this editing session's undo step.
  func commit() {
    pending?.cancel()
    pending = nil
    dirty = false
    guard step < session.stepCount() else { return }
    var f = session.stepFields(step)
    f.title = std.string(title)
    f.notes = std.string(notes)
    f.pauseAfter = pauseAfter
    model.document.perform { session.setStepFields(step, f, true) }
  }

  /// The popover closed: what is still waiting is written, and the undo step ends.
  func close() {
    if dirty || pending != nil { commit() }
    session.endGesture()
  }

  var items: [bmapp.ItemRow] { _ = model.steps; return model.items(of: step) }

  func reorder(from source: IndexSet, to destination: Int) {
    guard let from = source.first else { return }
    let to = destination > from ? destination - 1 : destination
    guard to != from else { return }
    session.endGesture()
    model.context.perform { $0.reorderInStep(step, from, to) }
  }

  var canSplit: Bool {
    let mine = Set(session.piecesOfStep(step)), chosen = model.snapshot.selection
    return !chosen.isEmpty && chosen.allSatisfy { mine.contains($0) } && chosen.count < mine.count
  }

  func split() {
    session.endGesture()
    let pieces = Array(model.snapshot.selection)
    model.context.perform { $0.splitStep(step, ViewportView.list(pieces)) }
  }

  var canMerge: Bool { step + 1 < model.steps.count }

  func merge() {
    session.endGesture()
    model.context.perform { $0.mergeSteps(step) }
  }
}

struct StepEditor: View {
  @State var editor: StepEditorModel

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Step \(editor.step + 1)").font(.headline)
      Form {
        TextField("Title", text: $editor.title, prompt: Text("Untitled"))
        LabeledContent("Notes") {
          TextEditor(text: $editor.notes)
            .font(.body)
            .frame(height: 64)
            .scrollContentBackground(.hidden)
            .padding(4)
            .background(.background.secondary, in: .rect(cornerRadius: 6))
        }
        LabeledContent("Pause After") {
          HStack(spacing: 6) {
            TextField("Pause", value: $editor.pauseAfter, format: .number.precision(.fractionLength(0...1)))
              .labelsHidden()
              .multilineTextAlignment(.trailing)
              .frame(width: 48)
            Text("s").foregroundStyle(.secondary)
            Stepper("Pause After", value: $editor.pauseAfter, in: 0...10, step: 0.1).labelsHidden()
          }
        }
      }
      .formStyle(.columns)
      VStack(alignment: .leading, spacing: 4) {
        Text("Piece Order").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
        List {
          ForEach(editor.items, id: \.item) { item in
            Text(displayName(String(item.submodel || item.description.empty() ? item.name : item.description)))
              .lineLimit(1)
          }
          .onMove { editor.reorder(from: $0, to: $1) }
        }
        .listStyle(.bordered)
        .alternatingRowBackgrounds()
        .frame(height: 150)
      }
      HStack {
        Button("Split at Selection") { editor.split() }.disabled(!editor.canSplit)
        Button("Merge with Next") { editor.merge() }.disabled(!editor.canMerge)
        Spacer()
      }
    }
    .padding(16)
    .frame(width: 340)
    .onDisappear { editor.close() }
  }
}
