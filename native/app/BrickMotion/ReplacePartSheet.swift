// Replace Part…: a sheet that searches the LDraw library by number or description.
import AppKit
import BMApp
import SwiftUI

struct ReplacePartView: View {
  let session: bmapp.Session
  let done: (String?) -> Void
  @State private var query = ""
  @State private var matches: [Match] = []
  @State private var chosen: String?

  struct Match: Identifiable, Hashable {
    let name: String, description: String
    var id: String { name }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Replace Part").font(.headline)
      TextField("Search by number or description", text: $query)
        .textFieldStyle(.roundedBorder)
        .onSubmit { if let chosen { done(chosen) } }
      List(matches, selection: $chosen) { m in
        HStack {
          Text(m.name).monospacedDigit().frame(width: 110, alignment: .leading)
          Text(m.description).foregroundStyle(.secondary).lineLimit(1)
        }
        .tag(m.name)
      }
      .frame(minHeight: 260)
      .overlay {
        if matches.isEmpty && !query.isEmpty { Text("No parts match").foregroundStyle(.secondary) }
      }
      HStack {
        Spacer()
        Button("Cancel", role: .cancel) { done(nil) }.keyboardShortcut(.cancelAction)
        Button("Replace") { done(chosen) }.keyboardShortcut(.defaultAction).disabled(chosen == nil)
      }
    }
    .padding(20)
    .frame(width: 520)
    .onChange(of: query) { _, q in search(q) }
  }

  private func search(_ q: String) {
    var out: [Match] = []
    for m in session.searchParts(std.string(q), 200) {
      out.append(Match(name: String(m.name), description: String(m.description)))
    }
    matches = out
    chosen = out.first?.name
  }
}

enum ReplacePartSheet {
  @MainActor static func present(on window: NSWindow, session: bmapp.Session, choose: @escaping (String) -> Void) {
    var sheet: NSWindow?
    let view = ReplacePartView(session: session) { part in
      if let sheet { window.endSheet(sheet) }
      if let part { choose(part) }
    }
    let s = NSWindow(contentViewController: NSHostingController(rootView: view))
    s.title = "Replace Part"
    sheet = s
    window.beginSheet(s)
  }
}
