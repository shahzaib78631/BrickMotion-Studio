import BMApp
import SwiftUI

struct JointCard: View {
  let model: DocumentModel

  var body: some View {
    if let joint = model.assemblyReview.joint {
      VStack(alignment: .leading, spacing: 9) {
        HStack {
          Label(joint.type.title, systemImage: "link").font(.headline)
          Spacer()
          Button {
            model.assemblyReview.openJoint(nil)
            model.viewport?.updateEditorOverlays()
          } label: {
            Image(systemName: "xmark")
          }
          .buttonStyle(.borderless)
          .accessibilityLabel("Close connection")
        }
        VStack(alignment: .leading, spacing: 4) {
          Text(part(joint.a)).lineLimit(1)
          Text(part(joint.b)).lineLimit(1)
        }
        .font(.callout)
        .foregroundStyle(.secondary)
        if joint.type == .Hinge || joint.type == .Cylindrical || joint.type == .Ball {
          HStack {
            Button { model.assemblyReview.changeJoint(model, degrees: -15) } label: {
              Image(systemName: "rotate.left")
            }
            .help("Rotate −15°").accessibilityLabel("Rotate left 15 degrees")
            Spacer()
            Text("\(Int(joint.angle.rounded()))°").font(.callout.monospacedDigit())
              .accessibilityLabel("Joint angle \(Int(joint.angle.rounded())) degrees")
            Spacer()
            Button { model.assemblyReview.changeJoint(model, degrees: 15) } label: {
              Image(systemName: "rotate.right")
            }
            .help("Rotate 15°").accessibilityLabel("Rotate right 15 degrees")
          }
          .disabled(model.assemblyReview.changing)
        }
        if let error = model.assemblyReview.jointError {
          Text(error).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        HStack {
          Button("Select Rigid Body") { model.assemblyReview.selectBody(piece: joint.b, model: model) }
          Spacer()
          Button("Detach") { model.assemblyReview.changeJoint(model, degrees: 0) }
            .disabled(model.assemblyReview.changing)
        }
      }
      .padding(12)
      .frame(width: 240)
      .glassEffect(.regular, in: .rect(cornerRadius: 14))
      .overlay {
        RoundedRectangle(cornerRadius: 14).strokeBorder(.primary.opacity(0.12), lineWidth: 0.5).allowsHitTesting(false)
      }
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Connection controls")
    }
  }

  private func part(_ piece: UInt32) -> String {
    displayName(String(model.document.session.partAt(piece).description))
  }
}
