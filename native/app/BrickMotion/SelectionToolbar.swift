import SwiftUI

struct SelectionToolbar: View {
  let model: DocumentModel

  var body: some View {
    HStack(spacing: 9) {
      action("view.frameSelection")
      Divider().frame(height: 16)
      action("object.makeSubmodel")
      action("object.group")
      action("object.fitTogether")
      action("edit.duplicate")
      action("object.rotateCW")
      Menu {
        menuAction("object.extract")
        menuAction("select.rigid")
        menuAction("view.layOut")
        menuAction("edit.hide")
        Divider()
        menuAction("edit.delete")
      } label: {
        Label("More selection actions", systemImage: "ellipsis").labelStyle(.iconOnly)
      }
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
      .fixedSize()
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .glassEffect(.regular, in: .capsule)
    .overlay { Capsule().strokeBorder(.primary.opacity(0.12), lineWidth: 0.5).allowsHitTesting(false) }
    .fixedSize()
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Selection actions")
  }

  @ViewBuilder private func action(_ id: String) -> some View {
    if let command = Registry.command(id) {
      Button { command.run(model.context) } label: {
        Label(command.title, systemImage: command.symbol ?? "scope").labelStyle(.iconOnly)
          .frame(width: 20, height: 22)
      }
      .buttonStyle(.borderless)
      .disabled(!command.enabled(model.context))
      .help(command.title)
    }
  }

  @ViewBuilder private func menuAction(_ id: String) -> some View {
    if let command = Registry.command(id) {
      Button(command.title) { command.run(model.context) }.disabled(!command.enabled(model.context))
    }
  }
}
