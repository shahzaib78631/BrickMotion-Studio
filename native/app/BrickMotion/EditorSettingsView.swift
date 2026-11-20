import SwiftUI

struct EditorSettingsView: View {
  @Bindable var preferences: EditorPreferences

  var body: some View {
    TabView {
      Tab("Appearance", systemImage: "circle.lefthalf.filled") {
        Form {
          Picker("Appearance", selection: $preferences.appearance) {
            ForEach(EditorPreferences.Appearance.allCases, id: \.self) { Text($0.rawValue).tag($0) }
          }
          .pickerStyle(.segmented)
        }
        .formStyle(.grouped)
      }
      Tab("Viewport", systemImage: "cube") {
        Form {
          Section {
            Toggle("Part edges", isOn: $preferences.edges)
            Toggle("Floor", isOn: $preferences.floor)
            Toggle("Floating selection actions", isOn: $preferences.selectionBar)
          }
          Section {
            Toggle("Shadows", isOn: $preferences.shadows)
            Toggle("Ambient occlusion", isOn: $preferences.ambientOcclusion)
          }
        }
        .formStyle(.grouped)
      }
      Tab("Planning", systemImage: "list.number") {
        Form {
          Section {
            Toggle("Update build preview after edits", isOn: $preferences.autoPlan)
          } footer: {
            Text("Planning runs in the background once you’ve previewed a build.")
          }
        }
        .formStyle(.grouped)
      }
    }
    .frame(width: 490, height: 290)
  }
}
