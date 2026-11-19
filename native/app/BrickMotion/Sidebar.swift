// The window's left pane: a navigator with Models, Steps and Parts.
import BMApp
import SwiftUI

struct Sidebar: View {
  @Bindable var model: DocumentModel

  var body: some View {
    VStack(spacing: 0) {
      Picker("Navigator", selection: $model.sidebarTab) {
        Image(systemName: "cube").help("Models").tag(SidebarTab.models)
        Image(systemName: "list.number").help("Steps").tag(SidebarTab.steps)
        Image(systemName: "square.grid.2x2").help("Parts").tag(SidebarTab.parts)
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      Divider()
      switch model.sidebarTab {
      case .models: ModelsPane(model: model)
      case .steps: StepsList(model: model)
      case .parts:
        ContentUnavailableView("Parts", systemImage: "square.grid.2x2", description: Text("Parts arrive in the next milestone."))
      }
    }
  }
}

/// The steps of the model being edited, until the Steps pane lands.
private struct StepsList: View {
  let model: DocumentModel
  var body: some View {
    List(model.steps, id: \.index) { step in
      let title = String(step.title)
      Label(title.isEmpty ? "Step \(step.index + 1)" : "\(step.index + 1). \(title)", systemImage: "square.stack.3d.up")
        .badge(Int(step.pieces))
    }
    .listStyle(.sidebar)
  }
}
