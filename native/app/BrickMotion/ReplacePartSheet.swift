// Replace Part…: a sheet that searches the LDraw library by number or description.
import AppKit
import SwiftUI

struct ReplacePartView: View {
  let done: (String?) -> Void
  @State private var query = ""
  @State private var matches: [LibraryPart] = []
  @State private var completedQuery = ""
  @State private var chosen: String?

  private var ready: Bool { completedQuery == query }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Replace Part").font(.headline)
      TextField("Search by number or description", text: $query)
        .textFieldStyle(.roundedBorder)
        .onSubmit { if ready, let chosen { done(chosen) } }
      List(ready ? matches : [], selection: $chosen) { part in
        HStack {
          Text(part.number).monospacedDigit().frame(width: 110, alignment: .leading)
          Text(part.name).foregroundStyle(.secondary).lineLimit(1)
        }
        .tag(part.id)
      }
      .frame(minHeight: 260)
      .overlay {
        if !ready {
          ProgressView().controlSize(.small).accessibilityLabel("Searching parts")
        } else if matches.isEmpty && !query.isEmpty {
          Text("No parts match").foregroundStyle(.secondary)
        }
      }
      HStack {
        Spacer()
        Button("Cancel", role: .cancel) { done(nil) }.keyboardShortcut(.cancelAction)
        Button("Replace") { done(chosen) }.keyboardShortcut(.defaultAction).disabled(!ready || chosen == nil)
      }
    }
    .padding(20)
    .frame(width: 520)
    .task(id: query) { await search(query) }
  }

  private func search(_ requested: String) async {
    var found: [LibraryPart] = []
    if !requested.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      let library = await PartsCatalog.shared.library()
      found = await PartsCatalog.shared.search(in: library.directory, query: requested, category: nil, limit: 200)
    }
    guard !Task.isCancelled, requested == query else { return }
    matches = found
    chosen = found.first?.id
    completedQuery = requested
  }
}

enum ReplacePartSheet {
  @MainActor static func present(on window: NSWindow, choose: @escaping (String) -> Void) {
    var sheet: NSWindow?
    let view = ReplacePartView { part in
      if let sheet { window.endSheet(sheet) }
      if let part { choose(part) }
    }
    let s = NSWindow(contentViewController: NSHostingController(rootView: view))
    s.title = "Replace Part"
    sheet = s
    window.beginSheet(s)
  }
}
