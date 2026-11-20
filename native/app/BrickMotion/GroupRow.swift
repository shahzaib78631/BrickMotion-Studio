import BMApp
import SwiftUI

struct GroupRow: View {
  let model: DocumentModel

  var body: some View {
    let session = model.document.session
    let pieces = model.snapshot.selection
    let current = session.groupsOf(pieces).map { String($0) }
    let known = session.groupNames().map { String($0) }
    LabeledContent("Group") {
      Menu(current.isEmpty ? "None" : current.count == 1 ? current[0] : "Mixed") {
        Button("Set Group…") { Registry.command("object.group")?.run(model.context) }
        if !known.isEmpty {
          Divider()
          ForEach(known, id: \.self) { name in
            Button(name) { model.context.perform { $0.setGroup(pieces, std.string(name)) } }
          }
        }
        if !current.isEmpty {
          Divider()
          Button("Remove from Group") { Registry.command("object.ungroup")?.run(model.context) }
        }
      }
    }
  }
}
