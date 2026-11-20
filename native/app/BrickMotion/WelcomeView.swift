import AppKit
import SwiftUI

struct WelcomeView: View {
  let recent: [URL]
  let open: (URL) -> Void
  @State private var selection: URL?
  @State private var importing: URL?

  var body: some View {
    HStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 18) {
        PartPreviewImage(part: "3001.dat", color: 4)
          .frame(width: 84, height: 84)
          .clipShape(.rect(cornerRadius: 19))
        Text("BrickMotion")
          .font(.largeTitle.weight(.semibold))
          .accessibilityAddTraits(.isHeader)
        VStack(spacing: 8) {
          Button {
            NSDocumentController.shared.newDocument(nil)
          } label: {
            Label("New Project", systemImage: "plus")
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .buttonStyle(.borderedProminent)
          Button {
            NSDocumentController.shared.openDocument(nil)
          } label: {
            Label("Open File…", systemImage: "folder")
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .buttonStyle(.bordered)
        }
        .controlSize(.large)
        if let importing {
          HStack(spacing: 7) {
            ProgressView().controlSize(.mini)
            Text("Opening \(importing.lastPathComponent)…").lineLimit(1)
          }
          .font(.caption)
          .foregroundStyle(.secondary)
          .accessibilityElement(children: .combine)
        }
      }
      .padding(30)
      .frame(width: 282)
      .frame(maxHeight: .infinity)
      Divider()
      VStack(alignment: .leading, spacing: 12) {
        Text("Recent Documents")
          .font(.title3.weight(.semibold))
          .accessibilityAddTraits(.isHeader)
          .padding(.horizontal, 20)
        if recent.isEmpty {
          VStack(spacing: 8) {
            Image(systemName: "clock").font(.system(size: 27, weight: .light)).foregroundStyle(.tertiary)
            Text("No Recent Documents").font(.headline).foregroundStyle(.secondary)
            Text("Opened projects will appear here.").font(.callout).foregroundStyle(.secondary)
          }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          List(recent, id: \.self, selection: $selection) { url in
            RecentProjectRow(url: url)
              .tag(url)
              .simultaneousGesture(TapGesture(count: 2).onEnded { open(url) })
              .contextMenu {
                Button("Open") { open(url) }
                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
              }
          }
          .listStyle(.inset)
          .scrollContentBackground(.hidden)
          .onKeyPress(.return) {
            guard let selection else { return .ignored }
            open(selection)
            return .handled
          }
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .padding(.top, 38)
      .padding(.bottom, 12)
      .background(.primary.opacity(0.032))
    }
    .frame(minWidth: 670, minHeight: 390)
    .onReceive(NotificationCenter.default.publisher(for: DocumentController.importProgress)) { notification in
      importing = (notification.object as? DocumentController)?.importing.first
    }
    .onAppear { importing = (NSDocumentController.shared as? DocumentController)?.importing.first }
  }
}
