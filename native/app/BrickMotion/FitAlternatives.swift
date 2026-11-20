import AppKit
import BMApp
import SwiftUI

struct FitAlternatives: View {
  let fits: [bmapp.FitPose]
  let onPreview: (Int) -> Void
  let onApply: (Int) -> Void
  let onCancel: () -> Void
  @State private var selection: Int? = 0

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      Text("Ways to Fit").font(.headline)
      List(fits.indices, id: \.self, selection: $selection) { index in
        HStack {
          Label(index == 0 ? "Closest Placement" : "Placement \(index + 1)", systemImage: "link")
          Spacer()
          Text(fits[index].travel.formatted(.number.precision(.fractionLength(1))) + " LDU")
            .monospacedDigit().foregroundStyle(.secondary)
        }
        .tag(index)
      }
      .listStyle(.inset)
      .frame(height: min(215, CGFloat(fits.count) * 27 + 10))
      HStack {
        Spacer()
        Button("Cancel", action: onCancel).keyboardShortcut(.cancelAction)
        Button("Apply Fit") { if let selection { onApply(selection) } }
          .keyboardShortcut(.defaultAction)
          .disabled(selection == nil)
      }
    }
    .padding(14)
    .frame(width: 290)
    .onChange(of: selection, initial: true) { _, value in if let value { onPreview(value) } }
  }
}

@MainActor enum FitSheet {
  static func show(_ fits: [bmapp.FitPose], moving piece: UInt32, model: DocumentModel, apply: @escaping (Int) -> Void) {
    guard let viewport = model.viewport, let window = viewport.window else { return }
    let sheet = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 290, height: 180),
                         styleMask: [.titled], backing: .buffered, defer: false)
    sheet.title = "Ways to Fit"
    viewport.placement.cancel()
    model.animation.rest()
    let dismiss: () -> Void = { [weak sheet, weak viewport] in
      viewport?.viewport.clearPlacementPreview()
      viewport?.changed()
      if let sheet { window.endSheet(sheet) }
    }
    let view = FitAlternatives(fits: fits) { [weak viewport] index in
      viewport?.viewport.previewFit(piece, fits[index].pose)
      viewport?.changed()
    } onApply: { index in
      dismiss()
      apply(index)
    } onCancel: {
      dismiss()
    }
    sheet.contentViewController = NSHostingController(rootView: view)
    window.beginSheet(sheet)
  }
}
