import AppKit
import BMApp
import UniformTypeIdentifiers

@MainActor enum InventoryImportSheet {
  // The captured geometry is isolated from the editor. Only the preparation task mutates it.
  private struct Draft: @unchecked Sendable {
    let inventory: bmapp.InventoryImport
  }

  private struct Summary: Sendable {
    let error: String
    let pieces: Int
    let spares: Int
    let invalidRows: Int
    let missing: [String]

    var details: String {
      var lines: [String] = []
      if invalidRows > 0 { lines.append("Unreadable rows: \(invalidRows.formatted())") }
      if spares > 0 { lines.append("Spare pieces skipped: \(spares.formatted())") }
      if !missing.isEmpty {
        let names = missing.prefix(8).map(displayName).joined(separator: ", ")
        lines.append("Missing part files: \(names)")
        if missing.count > 8 { lines.append("\((missing.count - 8).formatted()) more missing part files") }
      }
      return lines.joined(separator: "\n")
    }
  }

  static func show(in model: DocumentModel) {
    guard !model.importing, let window = model.viewport?.window else { return }
    let panel = NSOpenPanel()
    panel.allowedContentTypes = [.commaSeparatedText, UTType(filenameExtension: "pbg")].compactMap { $0 }
    panel.title = "Import Parts Inventory"
    panel.message = "Choose a Rebrickable CSV or a Studio parts-bin file."
    panel.prompt = "Import"
    panel.beginSheetModal(for: window) { [weak model] response in
      guard response == .OK, let url = panel.url, let model,
            let inventory = bmapp.InventoryImport.capture(model.document.session, Int32(model.selectedStep ?? -1)) else { return }
      let draft = Draft(inventory: inventory)
      model.importing = true
      Task { @MainActor in
        defer { model.importing = false }
        let summary = await Task.detached(priority: .userInitiated) {
          let result = draft.inventory.prepare(std.string(url.path))
          return Summary(error: String(result.error), pieces: result.pieces, spares: result.spares,
                         invalidRows: result.invalidRows, missing: result.missing.map { String($0) })
        }.value
        guard let viewport = model.viewport, viewport.window === window else { return }
        if !summary.error.isEmpty {
          showReport("Couldn’t Import Parts", detail: summary.error, in: window)
        } else if summary.pieces == 0 {
          showReport("No Parts to Import", detail: summary.details.isEmpty ? "The file contains no part entries." : summary.details, in: window)
        } else if model.context.perform({ $0.importInventory(draft.inventory) }) {
          viewport.frameSelection(nil)
          if summary.invalidRows > 0 || !summary.missing.isEmpty {
            let title = summary.pieces == 1 ? "Imported 1 Part" : "Imported \(summary.pieces.formatted()) Parts"
            showReport(title, detail: summary.details, in: window)
          }
        }
      }
    }
  }

  private static func showReport(_ title: String, detail: String, in window: NSWindow) {
    let report = NSAlert()
    report.messageText = title
    report.informativeText = detail
    report.addButton(withTitle: "Done")
    report.beginSheetModal(for: window)
  }
}
