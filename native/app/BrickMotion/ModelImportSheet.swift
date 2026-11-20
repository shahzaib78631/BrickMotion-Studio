import AppKit
import BMApp
import UniformTypeIdentifiers

@MainActor enum ModelImportSheet {
  // The C++ source and its error are immutable after read returns.
  private struct ReadResult: @unchecked Sendable {
    let file: bmapp.ModelImport?
  }

  static func show(in model: DocumentModel, into name: String) {
    guard !model.importing, let window = model.viewport?.window else { return }
    let panel = NSOpenPanel()
    panel.allowedContentTypes = bmapp.documentTypes().compactMap { UTType(String($0.uti)) }
    panel.title = "Import Model"
    panel.message = name.isEmpty ? "Choose a file to add to this project." : "Choose a file to add to \(displayName(name))."
    panel.prompt = "Import"
    panel.beginSheetModal(for: window) { [weak model] response in
      guard response == .OK, let url = panel.url, let model else { return }
      let generation = model.document.session.generation()
      model.importing = true
      Task { @MainActor in
        defer { model.importing = false }
        let result = await Task.detached(priority: .userInitiated) {
          ReadResult(file: bmapp.ModelImport.read(std.string(url.path)))
        }.value
        guard model.viewport?.window != nil else { return }
        model.context.perform { $0.importModel(result.file, std.string(name), generation) }
      }
    }
  }
}
