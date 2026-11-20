// The window's left pane: a navigator with Models, Steps and Parts.
import BMApp
import SwiftUI

struct Sidebar: View {
  @Bindable var model: DocumentModel

  var body: some View {
    VStack(spacing: 0) {
      Picker("Navigator", selection: $model.sidebarTab) {
        Image(systemName: "cube").accessibilityLabel("Models").help("Models").tag(SidebarTab.models)
        Image(systemName: "list.number").accessibilityLabel("Steps").help("Steps").tag(SidebarTab.steps)
        Image(systemName: "square.grid.2x2").accessibilityLabel("Parts").help("Parts").tag(SidebarTab.parts)
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      Divider()
      switch model.sidebarTab {
      case .models: ModelsPane(model: model)
      case .steps: StepsPane(model: model)
      case .parts: PartsPane(model: model)
      }
    }
  }
}
