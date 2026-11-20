import BMApp
import SwiftUI

struct StepCallout: View {
  let model: DocumentModel
  let workspace: AnimationWorkspace
  @State private var showingParts = false

  var body: some View {
    if workspace.visible, workspace.tab == .build, let index = workspace.currentStep, model.steps.indices.contains(index),
       workspace.focusedStep != nil || workspace.state.playing || workspace.stepPreview != nil {
      let step = model.steps[index]
      VStack(alignment: .leading, spacing: 9) {
        header(index)
        if !step.title.empty() { Text(String(step.title)).font(.headline).lineLimit(2) }
        if !step.notes.empty() {
          Text(String(step.notes)).font(.callout).foregroundStyle(.secondary).lineLimit(2)
        }
        HStack(spacing: 8) {
          Button {
            showingParts.toggle()
          } label: {
            Label("\(step.pieces) \(step.pieces == 1 ? "part" : "parts")", systemImage: "cube")
          }
          .buttonStyle(.borderless)
          .popover(isPresented: $showingParts, arrowEdge: .bottom) { parts(index) }
          Spacer()
          Menu {
            Button("Stop Here") { workspace.select(step: index) }
            Button("Play Step") { workspace.play(step: index) }
            Button("Play to End") { workspace.play(step: index, throughEnd: true) }
          } label: {
            Label("Play", systemImage: "play.fill")
          }
          .fixedSize()
        }
        if !workspace.state.playing {
          Divider()
          Menu {
            Button("Assembled through This Step") { workspace.arrange(step: index, mode: .Assembled) }
            Button("Separated from Earlier Steps") { workspace.arrange(step: index, mode: .Separated) }
            Button("Lay Out These Parts") { workspace.arrange(step: index, mode: .LaidOut) }
            Button("Explode This Step") { workspace.arrange(step: index, mode: .Exploded) }
            Divider()
            Button("Show All Steps", action: workspace.rest)
          } label: {
            Label(workspace.previewName, systemImage: "square.3.layers.3d")
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
      }
      .padding(12)
      .frame(width: 254)
      .glassEffect(.regular, in: .rect(cornerRadius: 14))
      .overlay {
        RoundedRectangle(cornerRadius: 14).strokeBorder(.primary.opacity(0.12), lineWidth: 0.5).allowsHitTesting(false)
      }
      .fixedSize()
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Step preview controls")
    }
  }

  private func header(_ step: Int) -> some View {
    HStack(spacing: 8) {
      Button { navigate(step - 1) } label: { Image(systemName: "chevron.left") }
        .buttonStyle(.borderless).disabled(step == 0)
        .help("Previous Step").accessibilityLabel("Previous step")
      Text("Step \(step + 1) of \(model.steps.count)").font(.callout.weight(.semibold).monospacedDigit())
        .frame(maxWidth: .infinity, alignment: .leading)
      Button { navigate(step + 1) } label: { Image(systemName: "chevron.right") }
        .buttonStyle(.borderless).disabled(step + 1 >= model.steps.count)
        .help("Next Step").accessibilityLabel("Next step")
      Button { workspace.rest() } label: { Image(systemName: "xmark") }
        .buttonStyle(.borderless).help("Show All Steps").accessibilityLabel("Close step preview")
    }
  }

  private func navigate(_ step: Int) {
    guard model.steps.indices.contains(step) else { return }
    model.select(step: step)
    if let mode = workspace.stepPreview { workspace.arrange(step: step, mode: mode) }
    else { workspace.select(step: step) }
  }

  private func parts(_ step: Int) -> some View {
    let items = Array(model.document.session.stepItems(step))
    return List(items, id: \.item) { item in
      Button {
        showingParts = false
        model.select(pieces: Array(item.pieces))
        model.viewport?.frameSelection(nil)
      } label: {
        Label(displayName(String(item.description)), systemImage: item.submodel ? "square.stack.3d.up" : "cube")
          .lineLimit(1)
      }
      .buttonStyle(.plain)
    }
    .frame(width: 260, height: 205)
    .accessibilityLabel("Parts in this step")
  }
}
