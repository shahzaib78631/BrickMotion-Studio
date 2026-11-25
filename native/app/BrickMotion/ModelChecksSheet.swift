import AppKit
import BMApp
import SwiftUI

@MainActor struct ModelChecksSheet: View {
  let model: DocumentModel
  let source: AssemblyInspectionWorker.Source
  let reveal: ([UInt32]) -> Void
  let close: () -> Void
  private let worker = AssemblyInspectionWorker()
  @State private var report: ModelChecksResult?

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 4) {
        Text("Model Checks").font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
        Text(model.document.displayName).foregroundStyle(.secondary).lineLimit(1)
      }
      .padding(21)
      Divider()
      Group {
        if let report {
          results(report)
        } else {
          ProgressView("Checking the model…").controlSize(.regular)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
      Divider()
      HStack {
        Spacer()
        Button("Done", action: close).keyboardShortcut(.defaultAction)
      }
      .padding(.horizontal, 21)
      .padding(.vertical, 13)
    }
    .frame(width: 490, height: 455)
    .task {
      let checked = await worker.checkModel(source)
      if !Task.isCancelled { report = checked }
    }
  }

  @ViewBuilder private func results(_ report: ModelChecksResult) -> some View {
    if !report.error.isEmpty {
      ContentUnavailableView("Couldn’t Check the Model", systemImage: "exclamationmark.triangle",
                             description: Text(report.error))
    } else if report.findings.isEmpty, model.refusedEdit == nil {
      ContentUnavailableView("No Findings", systemImage: "checkmark.shield",
                             description: Text("The model passed the available geometry and connection checks."))
    } else {
      let grouped = Dictionary(grouping: report.findings, by: \.kind)
      List {
        if let reason = model.refusedEdit {
          Section("Last Refused Edit") {
            VStack(alignment: .leading, spacing: 8) {
              Text(reason)
              Button("Dismiss") { model.refusedEdit = nil }
            }
            .padding(.vertical, 5)
          }
        }
        ForEach(ModelChecksResult.Kind.allCases) { kind in
          if let findings = grouped[kind] {
            Section(kind.rawValue) {
              ForEach(findings) { finding in
                if finding.pieces.isEmpty {
                  detail(finding)
                } else {
                  Button {
                    reveal(finding.pieces)
                  } label: {
                    HStack {
                      detail(finding)
                      Spacer(minLength: 8)
                      Image(systemName: "viewfinder").foregroundStyle(.secondary).accessibilityHidden(true)
                    }
                    .contentShape(Rectangle())
                  }
                  .buttonStyle(.plain)
                  .accessibilityHint("Select and frame these parts")
                }
              }
            }
          }
        }
      }
      .listStyle(.inset)
    }
  }

  private func detail(_ finding: ModelChecksResult.Finding) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(finding.title).font(.callout.weight(.medium))
      Text(finding.detail).font(.caption).foregroundStyle(.secondary)
    }
    .padding(.vertical, 5)
    .accessibilityElement(children: .combine)
  }

  static func show(_ context: CommandContext) {
    guard let model = context.model, let window = context.window, window.attachedSheet == nil,
          let native = bmapp.AssemblyInspection.capture(model.document.session) else { return }
    let source = AssemblyInspectionWorker.Source(native)
    let document = model.document
    let version = document.session.version(), generation = document.session.generation()
    let sheet = NSWindow()
    let close: () -> Void = { [weak window, weak sheet] in if let sheet { window?.endSheet(sheet) } }
    let view = ModelChecksSheet(model: model, source: source, reveal: { [weak model] ids in
      guard let model else { return }
      close()
      let session = model.document.session
      guard session.generation() == generation, session.version() == version else { return }
      model.animation.rest()
      session.show(ViewportView.list(ids))
      model.select(pieces: ids)
      model.viewport?.frameSelection(nil)
    }, close: close)
    sheet.contentViewController = NSHostingController(rootView: view)
    window.beginSheet(sheet)
  }
}
