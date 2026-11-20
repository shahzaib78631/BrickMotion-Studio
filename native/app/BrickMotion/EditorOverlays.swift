import AppKit
import BMApp
import SwiftUI

@MainActor final class EditorOverlays {
  private unowned let view: ViewportView
  private unowned let model: DocumentModel
  private let bar: NSHostingView<SelectionToolbar>
  private let card: NSHostingView<JointCard>
  private let markers = CAShapeLayer()
  private var hitPoints: [(joint: bmapp.JointRow, point: NSPoint)] = []

  init(view: ViewportView, model: DocumentModel) {
    self.view = view
    self.model = model
    bar = NSHostingView(rootView: SelectionToolbar(model: model))
    card = NSHostingView(rootView: JointCard(model: model))
    for overlay in [bar as NSView, card as NSView] {
      overlay.isHidden = true
      view.addSubview(overlay)
    }
    view.layer?.addSublayer(markers)
  }

  func update(suppressed: Bool) {
    let bounds = view.bounds
    let visible = !suppressed && bounds.width > 0 && bounds.height > 0
    let selection = !model.snapshot.selection.isEmpty
    let canShowBar = EditorPreferences.shared.selectionBar && visible && selection &&
      model.assemblyReview.joint == nil && model.snapshot.hidden < model.snapshot.pieces
    if canShowBar, let center = project(view.viewport.selectionCenter()), bounds.contains(center) {
      let size = bar.fittingSize
      place(bar, size: size, near: NSPoint(x: center.x - size.width / 2, y: center.y - 44))
    } else {
      bar.isHidden = true
    }
    if visible, let joint = model.assemblyReview.joint, let point = project(joint.point), bounds.contains(point) {
      let size = card.fittingSize
      place(card, size: size, near: NSPoint(x: point.x + 14, y: point.y - size.height / 2))
    } else {
      card.isHidden = true
    }
    let joints = visible && model.showJoints ? model.assemblyReview.report?.joints : nil
    updateMarkers(joints)
  }

  func selectJoint(at point: NSPoint) -> Bool {
    var best: (bmapp.JointRow, CGFloat)?
    for marker in hitPoints {
      let distance = hypot(point.x - marker.point.x, point.y - marker.point.y)
      if distance <= 11 && distance < (best?.1 ?? .infinity) { best = (marker.joint, distance) }
    }
    guard let (joint, _) = best else { return false }
    model.assemblyReview.openJoint(joint)
    update(suppressed: false)
    return true
  }

  private func project(_ p: bmapp.Vec3) -> NSPoint? {
    let projected = bmapp.projectPoint(view.viewport.camera(), bmapp.Vec2(x: view.bounds.width, y: view.bounds.height), p)
    guard projected.x.isFinite, projected.y.isFinite else { return nil }
    return NSPoint(x: projected.x, y: view.bounds.height - projected.y)
  }

  private func place(_ overlay: NSView, size: NSSize, near point: NSPoint) {
    let available = view.visibleRect.insetBy(dx: 12, dy: 12)
    guard size.width > 0, size.height > 0, size.width <= available.width, size.height <= available.height else {
      overlay.isHidden = true
      return
    }
    let x = min(max(point.x, available.minX), available.maxX - size.width)
    let y = min(max(point.y, available.minY), available.maxY - size.height)
    overlay.frame = NSRect(origin: NSPoint(x: x, y: y), size: size)
    overlay.isHidden = false
  }

  private func updateMarkers(_ joints: [bmapp.JointRow]?) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    defer { CATransaction.commit() }
    hitPoints.removeAll(keepingCapacity: true)
    guard let joints else { markers.isHidden = true; return }
    let outline = CGMutablePath()
    for joint in joints where joint.type != .Fixed {
      guard let p = project(joint.point), view.bounds.contains(p) else { continue }
      outline.addEllipse(in: CGRect(x: p.x - 4, y: p.y - 4, width: 8, height: 8))
      hitPoints.append((joint, p))
    }
    markers.frame = view.bounds
    markers.path = outline
    markers.lineWidth = 1
    markers.strokeColor = NSColor.white.cgColor
    markers.fillColor = NSColor.controlAccentColor.cgColor
    markers.contentsScale = view.scale
    markers.isHidden = hitPoints.isEmpty
  }
}
