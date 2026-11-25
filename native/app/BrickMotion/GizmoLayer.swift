// The move and rotate gizmos, drawn as shape layers over the Metal picture from bmapp's
// gizmoShape (points from the top left). Axes are the system red, green and blue; the handle
// under the pointer is drawn thicker in the accent colour.
import AppKit
import BMApp
import QuartzCore

final class GizmoLayer: CALayer {
  override init() {
    super.init()
    isGeometryFlipped = true  // y down, as the shape is given
  }
  override init(layer: Any) { super.init(layer: layer) }
  @available(*, unavailable) required init?(coder: NSCoder) { fatalError("not from a nib") }

  static func color(_ handle: bmapp.Handle) -> NSColor {
    switch handle {
    case .X, .YZ: return .systemRed
    case .Y, .XZ: return .systemGreen
    case .Z, .XY: return .systemBlue
    default: return .secondaryLabelColor
    }
  }

  /// Draws `shape`, or nothing; `appearance` resolves the system colours.
  func show(_ shape: bmapp.GizmoShape?, hovered: bmapp.Handle, scale: CGFloat, appearance: NSAppearance, squareTips: Bool = false) {
    if shape == nil && sublayers?.isEmpty != false { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    defer { CATransaction.commit() }
    sublayers?.forEach { $0.removeFromSuperlayer() }
    guard let shape else { return }
    appearance.performAsCurrentDrawingAppearance {
      for i in 0..<shape.rings.size() {
        let handle = shape.ringHandles[i]
        let plane = handle == .XY || handle == .YZ || handle == .XZ
        let path = CGMutablePath()
        let ring = shape.rings[i]
        for k in 0..<ring.size() {
          let p = CGPoint(x: ring[k].x, y: ring[k].y)
          if k == 0 { path.move(to: p) } else { path.addLine(to: p) }
        }
        path.closeSubpath()
        let hot = handle == hovered
        let color = hot ? NSColor.controlAccentColor : Self.color(handle)
        let layer = shapeLayer(path, color: color, width: hot ? 3 : (plane ? 1 : 2), scale: scale)
        if plane { layer.fillColor = color.withAlphaComponent(hot ? 0.5 : 0.25).cgColor }
        addSublayer(layer)
      }
      for i in 0..<shape.lines.size() {
        let line = shape.lines[i]
        let path = CGMutablePath()
        path.move(to: CGPoint(x: line.a.x, y: line.a.y))
        path.addLine(to: CGPoint(x: line.b.x, y: line.b.y))
        let hot = line.h == hovered
        let color = hot ? NSColor.controlAccentColor : Self.color(line.h)
        addSublayer(shapeLayer(path, color: color, width: hot ? 4 : 2.5, scale: scale))
        let rect = CGRect(x: line.b.x - 5, y: line.b.y - 5, width: 10, height: 10)
        let tip = squareTips ? CGPath(roundedRect: rect, cornerWidth: 2, cornerHeight: 2, transform: nil)
          : CGPath(ellipseIn: rect, transform: nil)
        let end = shapeLayer(tip, color: color, width: 0, scale: scale)
        end.fillColor = color.cgColor
        addSublayer(end)
      }
    }
  }

  private func shapeLayer(_ path: CGPath, color: NSColor, width: CGFloat, scale: CGFloat) -> CAShapeLayer {
    let s = CAShapeLayer()
    s.frame = bounds
    s.path = path
    s.strokeColor = color.cgColor
    s.fillColor = nil
    s.lineWidth = width
    s.lineCap = .round
    s.contentsScale = scale
    return s
  }
}

/// The small capsule by the pointer that reads out a drag.
final class DragReadout: NSTextField {
  init() {
    super.init(frame: .zero)
    isEditable = false
    isSelectable = false
    isBordered = false
    drawsBackground = false
    font = .monospacedDigitSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .medium)
    textColor = .labelColor
    alignment = .center
    wantsLayer = true
    layer?.cornerRadius = 9
    layer?.backgroundColor = NSColor.windowBackgroundColor.withAlphaComponent(0.85).cgColor
    isHidden = true
    setAccessibilityRole(.staticText)
  }
  @available(*, unavailable) required init?(coder: NSCoder) { fatalError("not from a nib") }

  func show(_ text: String, near point: NSPoint, in view: NSView) {
    stringValue = text
    sizeToFit()
    var f = frame
    f.size.width += 16
    f.size.height = 18
    f.origin = NSPoint(x: min(point.x + 14, view.bounds.width - f.width - 4), y: max(4, point.y - 30))
    frame = f
    isHidden = false
  }

  /// "X +3 studs  Y −2 plates": studs across, plates up (−y is up).
  static func move(_ d: bmapp.Vec3) -> String {
    func n(_ v: Double) -> String {
      let r = (v * 10).rounded() / 10
      let s = r == r.rounded() ? String(Int(r)) : String(format: "%.1f", r)
      return (r > 0 ? "+" : r < 0 ? "−" : "") + s.replacingOccurrences(of: "-", with: "")
    }
    var parts: [String] = []
    if d.x != 0 { parts.append("X \(n(d.x / bmapp.kStud))") }
    if d.z != 0 { parts.append("Z \(n(d.z / bmapp.kStud))") }
    var text = parts.isEmpty ? "" : parts.joined(separator: "  ") + " studs"
    if d.y != 0 { text += (text.isEmpty ? "" : "  ") + "Y \(n(-d.y / bmapp.kPlate)) plates" }
    return text.isEmpty ? "0" : text
  }

  static func angle(_ degrees: Double) -> String {
    let r = (degrees * 10).rounded() / 10
    return (r == r.rounded() ? String(Int(r)) : String(format: "%.1f", r)) + "°"
  }
}
