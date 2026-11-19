// The sidebar and inspector until their real panes arrive (milestone 3).
import SwiftUI

struct SidebarPlaceholder: View {
  let title: String
  let pieces: Int
  var body: some View {
    List {
      Section("Models") {
        Label(title, systemImage: "cube")
          .badge(pieces)
      }
    }
    .listStyle(.sidebar)
  }
}

struct InspectorPlaceholder: View {
  var body: some View {
    Form {
      Section("Inspector") {
        Text("Select a piece to see it here.")
          .foregroundStyle(.secondary)
      }
    }
    .formStyle(.grouped)
  }
}
