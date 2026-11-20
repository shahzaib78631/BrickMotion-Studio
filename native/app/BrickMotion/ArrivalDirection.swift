import BMApp
import SwiftUI

@MainActor enum ArrivalDirection {
  static let axes: [(String, bmapp.Vec3)] = [
    ("From Above", .init(x: 0, y: -1, z: 0)), ("From Below", .init(x: 0, y: 1, z: 0)),
    ("From Front", .init(x: 0, y: 0, z: -1)), ("From Back", .init(x: 0, y: 0, z: 1)),
    ("From Left", .init(x: -1, y: 0, z: 0)), ("From Right", .init(x: 1, y: 0, z: 0))
  ]

  static func label(_ d: bmapp.Vec3) -> String {
    if d.x == 0, d.y == 0, d.z == 0 { return "Automatic" }
    if let cardinal = axes.first(where: { abs(d.x * $0.1.x + d.y * $0.1.y + d.z * $0.1.z - 1) < 0.001 }) {
      return cardinal.0
    }
    return "Custom"
  }

  static func camera(_ view: ViewportView?) -> bmapp.Vec3 {
    guard let view else { return .init() }
    let pose = view.viewport.camera()
    let y = -sin(pose.pitch), h = cos(pose.pitch)
    return .init(x: -h * sin(pose.yaw), y: y, z: -h * cos(pose.yaw))
  }

  static func choose(_ model: DocumentModel) {
    let selected = Array(model.snapshot.selection)
    guard !selected.isEmpty else { return }
    let names = ["Automatic"] + axes.map(\.0) + ["From Current View"]
    model.context.choose("Insertion Direction", names) { index in
      let d = index == 0 ? bmapp.Vec3() :
        index <= axes.count ? axes[index - 1].1 : camera(model.viewport)
      model.context.perform { $0.setInsertionDirection(ViewportView.list(selected), d) }
    }
  }
}

struct ArrivalDirectionRow: View {
  let model: DocumentModel
  let piece: UInt32
  @State private var motion = false

  var body: some View {
    let direction = model.document.session.insertionDirection(piece)
    LabeledContent("Arrives") {
      Menu(ArrivalDirection.label(direction)) {
        Button("Automatic") { set(.init()) }
        Divider()
        ForEach(ArrivalDirection.axes.indices, id: \.self) { i in
          Button(ArrivalDirection.axes[i].0) { set(ArrivalDirection.axes[i].1) }
        }
        Divider()
        Button("From Current View") { set(ArrivalDirection.camera(model.viewport)) }
        Button("Edit Motion…") { motion = true }
      }
      .fixedSize()
      .popover(isPresented: $motion, arrowEdge: .leading) {
        let part = model.document.session.partAt(piece)
        MotionEditor(model: model, scope: .Parts, step: model.context.step ?? 0, pieces: [piece],
                     title: displayName(String(part.description)))
      }
      .accessibilityLabel("Insertion direction, \(ArrivalDirection.label(direction))")
    }
    .id(model.snapshot.version)
  }

  private func set(_ direction: bmapp.Vec3) {
    model.context.perform { $0.setInsertionDirection(ViewportView.list([piece]), direction) }
  }
}
