import BMApp
import SwiftUI

struct PartConnections: View {
  let model: DocumentModel
  let piece: UInt32

  var body: some View {
    let review = model.assemblyReview
    if let report = review.report {
      let joints = report.joints.filter { $0.a == piece || $0.b == piece }
      Section("Connections") {
        if !report.error.isEmpty {
          Text(report.error).font(.callout).foregroundStyle(.secondary)
        } else if joints.isEmpty {
          Text(report.withoutConnectors.contains(piece) ? "No connector data for this part" : "No attached parts")
            .font(.callout).foregroundStyle(.secondary)
        } else {
          ForEach(joints.indices, id: \.self) { index in
            let joint = joints[index]
            let other = joint.a == piece ? joint.b : joint.a
            let part = model.document.session.partAt(other)
            Button {
              review.joint = joint
              model.viewport?.updateEditorOverlays()
            } label: {
              LabeledContent {
                Text(joint.type.title).foregroundStyle(.secondary)
              } label: {
                Text(displayName(String(part.description))).lineLimit(1)
              }
            }
            .buttonStyle(.plain)
            .help("Inspect this connection")
          }
        }
      }
      if report.error.isEmpty {
        let overlaps = report.overlaps.filter { $0.a == piece || $0.b == piece }
        Section("Checks") {
          if overlaps.isEmpty {
            Label("No overlaps", systemImage: "checkmark.circle").foregroundStyle(.secondary)
          } else {
            ForEach(overlaps.indices, id: \.self) { index in
              let overlap = overlaps[index]
              let other = overlap.a == piece ? overlap.b : overlap.a
              let name = String(model.document.session.partAt(other).description)
              Label(overlap.duplicate ? "Duplicate placement" : "Intersects \(displayName(name))",
                    systemImage: "exclamationmark.triangle")
                .foregroundStyle(.primary)
            }
          }
        }
      }
    } else if review.loading {
      Section("Connections") { ProgressView().controlSize(.small).accessibilityLabel("Checking connections") }
    }
  }
}
