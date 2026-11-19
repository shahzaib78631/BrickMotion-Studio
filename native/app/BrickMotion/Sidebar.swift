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
      case .steps: StepsPane(model: model)
      case .parts:
        ContentUnavailableView("Parts", systemImage: "square.grid.2x2", description: Text("Parts arrive in the next milestone."))
      }
    }
  }
}
