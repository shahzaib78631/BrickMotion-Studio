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
            Toggle("Floating selection actions", isOn: $preferences.selectionBar)
          }
          Section {
            Toggle("Show the project’s scene backdrop", isOn: $preferences.sceneBackdrop)
          } footer: {
            Text("Shading, edges, shadows and the floor belong to each project: choose them in View → Look. Exports always use the project’s scene.")
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
          Section {
            Toggle("Play snap sounds with the build", isOn: $preferences.playSnapSounds)
          } footer: {
            Text("Uses the project’s mix from Step → Snap Sound, when it is switched on there.")
          }
        }
        .formStyle(.grouped)
      }
    }
    .frame(width: 490, height: 340)
  }
}
