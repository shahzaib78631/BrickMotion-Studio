import AppKit
import BMApp
import SwiftUI

struct CompatibleParts: View {
  struct Match: Identifiable, Sendable {
    let part: LibraryPart
    let x, y, z: Double
    var id: String { part.id }
    var contact: bmapp.Vec3 { bmapp.Vec3(x: x, y: y, z: z) }
  }

  let target: String
  let piece: UInt32
  let source: AssemblyInspectionWorker.Source
  let worker: AssemblyInspectionWorker
  let onPlace: (Match) -> Void
  let onClose: () -> Void
  @State private var query = ""
  @State private var loading = true
  @State private var results: [Match] = []
  @State private var selection: String?
  @FocusState private var searching: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      VStack(alignment: .leading, spacing: 3) {
        Text("Compatible Parts").font(.headline)
        Text(target).font(.callout).foregroundStyle(.secondary).lineLimit(1)
      }
      TextField("Search by part name or number", text: $query)
        .textFieldStyle(.roundedBorder).focused($searching)
      ZStack {
        if loading {
          ProgressView("Checking free connections…").controlSize(.small)
        } else if results.isEmpty {
          ContentUnavailableView("No Matching Parts", systemImage: "link",
            description: Text(query.isEmpty ? "Search the library for other parts." : "Try a different name or part number."))
        } else {
          List(results, selection: $selection) { result in
            HStack(spacing: 8) {
              PartPreviewImage(part: result.id, color: 71)
                .frame(width: 36, height: 36).clipShape(.rect(cornerRadius: 6))
              VStack(alignment: .leading, spacing: 2) {
                Text(result.part.name).font(.callout).lineLimit(1)
                Text(result.part.number).font(.caption).foregroundStyle(.secondary)
              }
            }
            .tag(result.id)
            .accessibilityElement(children: .combine)
          }
          .listStyle(.inset)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      HStack {
        Spacer()
        Button("Close", action: onClose).keyboardShortcut(.cancelAction)
        Button("Preview Placement") {
          if let match = results.first(where: { $0.id == selection }) { onPlace(match) }
        }
        .keyboardShortcut(.defaultAction)
        .disabled(selection == nil || loading)
      }
    }
    .padding(15)
    .frame(width: 395, height: 408)
    .task(id: query) { await load(query) }
    .onAppear { searching = true }
  }

  private func load(_ rawQuery: String) async {
    loading = true
    selection = nil
    let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    if !query.isEmpty { try? await Task.sleep(for: .milliseconds(140)) }
    guard !Task.isCancelled else { return }
    let library = await PartsCatalog.shared.library()
    let found: [LibraryPart]
    if query.isEmpty { found = library.common }
    else { found = await PartsCatalog.shared.search(in: library.directory, query: query, category: nil, limit: 160) }
    let matches = await worker.fitting(source, piece: piece, candidates: found)
    guard !Task.isCancelled else { return }
    results = matches
    selection = matches.first?.id
    loading = false
  }
}

@MainActor enum CompatiblePartsSheet {
  static func show(model: DocumentModel, piece: UInt32) {
    guard let window = model.viewport?.window,
          let captured = bmapp.AssemblyInspection.capture(model.document.session) else { return }
    let source = AssemblyInspectionWorker.Source(captured)
    let session = model.document.session
    let version = session.version(), generation = session.generation()
    let part = displayName(String(session.partAt(piece).description))
    let sheet = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 395, height: 408),
                         styleMask: [.titled], backing: .buffered, defer: false)
    sheet.title = "Compatible Parts"
    let view = CompatibleParts(target: part, piece: piece, source: source, worker: AssemblyInspectionWorker()) {
      [weak sheet, weak model] match in
      if let sheet { window.endSheet(sheet) }
      guard let model, let viewport = model.viewport, session.version() == version, session.generation() == generation else { return }
      model.animation.rest()
      let size = bmapp.Vec2(x: viewport.bounds.width, y: viewport.bounds.height)
      let screen = bmapp.projectPoint(viewport.viewport.camera(), size, match.contact)
      let point = NSPoint(x: screen.x, y: viewport.bounds.height - screen.y)
      model.browsedPart = match.part
      viewport.window?.makeFirstResponder(viewport)
      viewport.placement.begin(match.part, colour: model.partColour, turns: model.partTurns, mirrored: model.partMirrored,
                               step: model.selectedStep, reference: model.partReferenceHints,
                               at: point.x.isFinite && point.y.isFinite && viewport.bounds.contains(point) ? point : nil)
    } onClose: { [weak sheet] in
      if let sheet { window.endSheet(sheet) }
    }
    sheet.contentViewController = NSHostingController(rootView: view)
    window.beginSheet(sheet)
  }
}
