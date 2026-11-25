import BMApp
import SwiftUI

/// The same selection actions are available on a part row and in the browser's action menu.
struct ModelPartsActions: View {
  let model: DocumentModel
  let pieces: [UInt32]
  var sourceStep: Int?
  var modelToExclude: String?

  var body: some View {
    if !pieces.isEmpty {
      Button("Frame in View", systemImage: "viewfinder") {
        model.select(pieces: pieces)
        model.viewport?.frameSelection(nil)
      }
      Menu("Move to Step", systemImage: "list.number") {
        ForEach(model.steps, id: \.index) { step in
          let name = String(step.title)
          Button(name.isEmpty ? "Step \(step.index + 1)" : "Step \(step.index + 1) · \(name)") {
            model.context.perform { $0.moveToStep(ViewportView.list(pieces), Int(step.index)) }
          }
          .disabled(sourceStep == Int(step.index))
        }
        Divider()
        Button("New Step", systemImage: "plus") {
          model.context.perform { $0.moveToNewStep(ViewportView.list(pieces), model.steps.count) }
        }
      }
      let destinations = model.partsDestinations.filter { $0 != modelToExclude }
      if !destinations.isEmpty {
        Menu("Move to Submodel", systemImage: "arrow.right.square") {
          ForEach(destinations, id: \.self) { name in
            Button(displayName(name)) {
              model.context.perform { $0.moveToModel(ViewportView.list(pieces), std.string(name)) }
            }
          }
        }
      }
      Divider()
      Button("Set Group…", systemImage: "tag") { run("object.group") }
      if !model.document.session.groupsOf(ViewportView.list(pieces)).isEmpty {
        Button("Remove from Group", systemImage: "tag.slash") { run("object.ungroup") }
      }
      Button("Make Submodel…", systemImage: "shippingbox") { run("object.makeSubmodel") }
        .disabled(pieces.count < 2)
      Button("Delete", systemImage: "trash", role: .destructive) {
        model.context.perform { $0.remove(ViewportView.list(pieces)) }
      }
    }
  }

  private func run(_ command: String) {
    model.select(pieces: pieces)
    if let action = Registry.command(command), action.enabled(model.context) { action.run(model.context) }
  }
}
