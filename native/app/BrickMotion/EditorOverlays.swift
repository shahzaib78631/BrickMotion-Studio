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
  // A selected part's flight open as keys, drawn as its path (the web's flight path): the line a
  // frame at a time, a dot at each point that can be dragged, the one at the playhead larger.
  private let pathLine = CAShapeLayer()
  private let pathDots = CAShapeLayer()
  private let pathCurrent = CAShapeLayer()
  private var path: (piece: UInt32, version: UInt64, path: bmapp.FlightPath)?
  private var pathPoints: [FlightPathHit] = []
  private var pathSamples: [(frame: Int32, point: NSPoint)] = []

  /// A path point on screen.
  struct FlightPathHit {
    let piece: UInt32
    let frame: Int32
    let at: bmapp.Vec3
    let point: NSPoint
  }

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
    for layer in [pathLine, pathDots, pathCurrent] {
      layer.isHidden = true
      view.layer?.addSublayer(layer)
    }
  }

  func update(suppressed: Bool) {
    if suppressed && bar.isHidden && card.isHidden && markers.isHidden && pathLine.isHidden { return }
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
    updateFlightPath(visible: visible)
  }

  /// The path point under `point` (within a dot's reach), nearest first.
  func flightPathPoint(at point: NSPoint) -> FlightPathHit? {
    pathPoints.map { ($0, hypot(point.x - $0.point.x, point.y - $0.point.y)) }
      .filter { $0.1 <= 8 }.min { $0.1 < $1.1 }?.0
  }

  /// The frame where the path runs under `point` (within a few points of the line), for a new point.
  func flightPathFrame(at point: NSPoint) -> (piece: UInt32, frame: Int32)? {
    guard let path, pathSamples.count >= 2 else { return nil }
    var best: (frame: Int32, distance: CGFloat)?
    for (a, b) in zip(pathSamples, pathSamples.dropFirst()) {
      let dx = b.point.x - a.point.x, dy = b.point.y - a.point.y
      let length = dx * dx + dy * dy
      let t = length > 0 ? min(max(((point.x - a.point.x) * dx + (point.y - a.point.y) * dy) / length, 0), 1) : 0
      let distance = hypot(point.x - (a.point.x + t * dx), point.y - (a.point.y + t * dy))
      if distance <= 5 && distance < (best?.distance ?? .infinity) { best = (t < 0.5 ? a.frame : b.frame, distance) }
    }
    return best.map { (path.piece, $0.frame) }
  }

  private func updateFlightPath(visible: Bool) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    defer { CATransaction.commit() }
    pathPoints.removeAll(keepingCapacity: true)
    pathSamples.removeAll(keepingCapacity: true)
    let session = model.document.session
    let selection = Array(session.selection())
    guard visible, let animation = view.animation, animation.isKeyEditing, selection.count == 1,
          let piece = selection.first else {
      for layer in [pathLine, pathDots, pathCurrent] { layer.isHidden = true }
      return
    }
    let version = UInt64(session.version())
    if path?.piece != piece || path?.version != version {
      path = (piece, version, view.viewport.flightPath(piece))
    }
    guard let flight = path?.path, !flight.empty() else {
      for layer in [pathLine, pathDots, pathCurrent] { layer.isHidden = true }
      return
    }
    let line = CGMutablePath()
    var drawing = false
    for sample in flight.line {
      guard let p = project(sample.at) else { drawing = false; continue }
      pathSamples.append((sample.frame, p))
      if drawing { line.addLine(to: p) } else { line.move(to: p) }
      drawing = true
    }
    let scene = session.keyScene()
    let playhead = scene.first + Int32((animation.time * Double(scene.fps)).rounded())
    let dots = CGMutablePath(), current = CGMutablePath()
    for key in flight.keys {
      guard let p = project(key.at), view.bounds.insetBy(dx: -8, dy: -8).contains(p) else { continue }
      pathPoints.append(FlightPathHit(piece: piece, frame: key.frame, at: key.at, point: p))
      if key.frame == playhead {
        current.addEllipse(in: CGRect(x: p.x - 5.5, y: p.y - 5.5, width: 11, height: 11))
      } else {
        dots.addEllipse(in: CGRect(x: p.x - 4, y: p.y - 4, width: 8, height: 8))
      }
    }
    let frame = view.bounds
    pathLine.frame = frame
    pathLine.path = line
    pathLine.fillColor = nil
    pathLine.strokeColor = NSColor(srgbRed: 0x3a / 255, green: 0xa7 / 255, blue: 1, alpha: 0.9).cgColor
    pathLine.lineWidth = 2
    pathLine.lineJoin = .round
    pathLine.lineCap = .round
    pathDots.frame = frame
    pathDots.path = dots
    pathDots.fillColor = NSColor.white.cgColor
    pathDots.strokeColor = NSColor(srgbRed: 0x1d / 255, green: 0x5f / 255, blue: 0x99 / 255, alpha: 1).cgColor
    pathDots.lineWidth = 1.5
    pathCurrent.frame = frame
    pathCurrent.path = current
    pathCurrent.fillColor = NSColor(srgbRed: 1, green: 0xb0 / 255, blue: 0x20 / 255, alpha: 1).cgColor
    pathCurrent.strokeColor = NSColor.white.cgColor
    pathCurrent.lineWidth = 1.5
    for layer in [pathLine, pathDots, pathCurrent] {
      layer.contentsScale = view.scale
      layer.isHidden = false
    }
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
