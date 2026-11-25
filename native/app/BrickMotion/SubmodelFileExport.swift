import AppKit
import BMApp
import UniformTypeIdentifiers

@MainActor enum SubmodelFileExport {
  enum Format { case project, ldraw }

  static func show(_ context: CommandContext, name: String, format: Format) {
    guard let document = context.document, let window = context.window, window.attachedSheet == nil else { return }
    let panel = NSSavePanel()
    let suffix = format == .project ? "brickmotion" : "mpd"
    panel.allowedContentTypes = [UTType(filenameExtension: suffix) ?? .plainText]
    panel.nameFieldStringValue = displayName(name).replacingOccurrences(of: "/", with: " ") + "." + suffix
    panel.title = format == .project ? "Save Submodel Project" : "Export Submodel as LDraw"
    panel.prompt = format == .project ? "Save" : "Export"
    let generation = document.session.generation()
    panel.beginSheetModal(for: window) { [weak document] response in
      guard response == .OK, let url = panel.url, let document else { return }
      let session = document.session
      do {
        guard session.generation() == generation else { throw missingModel() }
        let model = std.string(name)
        let bytes = format == .project ? session.submodelProjectBytes(model) : session.submodelMpdBytes(model)
        guard !bytes.empty() else { throw missingModel() }
        try Data(String(bytes).utf8).write(to: url, options: .atomic)
      } catch {
        document.presentError(error)
      }
    }
  }

  private static func missingModel() -> NSError {
    NSError(domain: "BrickMotion.SubmodelExport", code: 1, userInfo: [
      NSLocalizedDescriptionKey: "The submodel changed before the export finished."
    ])
  }
}
