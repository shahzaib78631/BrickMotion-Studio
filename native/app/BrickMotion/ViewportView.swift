// The Metal viewport: a CAMetalLayer drawn by bmapp.Viewport only when something changed.
// Click selects (Shift toggles, double-click takes a submodel's whole use, and a double click on
// a use already selected opens its submodel), a drag on empty space
// marquees (Option: touching), right-drag or two-finger scroll orbits, Shift pans, pinch zooms,
// rotate turns; Space plays. The editing keys are in EditCommands.swift.
import AppKit
import BMApp
import QuartzCore

final class ViewportView: NSView, @preconcurrency CAMetalDisplayLinkDelegate {
  let viewport: bmapp.Viewport
  /// The document edits go through (for their undo); set by the window controller.
  weak var document: Document? {
    didSet {
      // A selector observer: the centre drops it when this view goes.
      NotificationCenter.default.removeObserver(self, name: Document.didChange, object: nil)
      NotificationCenter.default.addObserver(self, selector: #selector(documentChanged(_:)), name: Document.didChange, object: document)
    }
  }
  @objc private func documentChanged(_ note: Notification) { changed() }
  private var pressPoint: NSPoint?
  /// The selection as a click began: a double click on a use already selected opens it.
  private var selectionAtPress: [UInt32] = []
  private var marqueeLayer: CAShapeLayer?

  // MARK: Tools

  enum Tool: Int { case select, move, rotate }
  /// The pointer's tool; the toolbar shows it (V and M choose it too).
  var tool = Tool.select {
    didSet {
      if tool != oldValue { onTool?(tool) }
      updateGizmo()
    }
  }
  var onTool: ((Tool) -> Void)?
  /// L: the gizmo follows the first selected piece's own axes instead of the world's.
  var localAxes = false {
    didSet { updateGizmo() }
  }
  private let gizmoLayer = GizmoLayer()
  private let readout = DragReadout()
  private(set) var gizmo: bmapp.GizmoShape?
  private var hovered = bmapp.Handle.None
  /// A gizmo drag: what it started from, and how far it has gone so far.
  private struct GizmoDrag {
    var handle: bmapp.Handle
    var start: (Double, Double)
    var origin: bmapp.Vec3
    var axes: bmapp.Mat3
    var pieces: bmapp.PieceList
    var moved = bmapp.Vec3()
    var turned = 0.0
  }
  private var gizmoDrag: GizmoDrag?
  /// Called on the main thread when planning starts or ends, for the toolbar's progress.
  var onPlanState: ((bmapp.PlanState) -> Void)?
  private var link: CAMetalDisplayLink?
  private var lastPoint = NSPoint.zero
  private var lastPlanState = bmapp.PlanState.Idle

  init(session: bmapp.Session) {
    viewport = bmapp.Viewport.create(session)!
    super.init(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
    wantsLayer = true
    layerContentsRedrawPolicy = .never
    setAccessibilityRole(.group)
    setAccessibilityLabel("Model viewport")
    addSubview(readout)
    addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self))
  }

  @available(*, unavailable) required init?(coder: NSCoder) { fatalError("not from a nib") }

  override func makeBackingLayer() -> CALayer {
    let layer = CAMetalLayer()
    if let device = bmapp.Viewport.metalDevice() {
      layer.device = Unmanaged<MTLDevice>.fromOpaque(device).takeUnretainedValue()
    }
    layer.pixelFormat = .bgra8Unorm_srgb
    layer.framebufferOnly = true
    layer.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
    return layer
  }

  private var metalLayer: CAMetalLayer { layer as! CAMetalLayer }
  override var acceptsFirstResponder: Bool { true }
  override var isOpaque: Bool { true }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    guard window != nil else {
      link?.invalidate()
      link = nil
      return
    }
    updateSize()
    updateBackground()
    if gizmoLayer.superlayer == nil { layer?.addSublayer(gizmoLayer) }
    if link == nil {
      let l = CAMetalDisplayLink(metalLayer: metalLayer)
      l.delegate = self
      l.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
      l.add(to: .main, forMode: .common)
      link = l
    }
    changed()
  }

  override func viewDidChangeBackingProperties() {
    super.viewDidChangeBackingProperties()
    updateSize()
  }

  override func setFrameSize(_ newSize: NSSize) {
    super.setFrameSize(newSize)
    updateSize()
  }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    updateBackground()
  }

  var scale: Double { Double(window?.backingScaleFactor ?? 2) }

  private func updateSize() {
    metalLayer.contentsScale = scale
    gizmoLayer.frame = bounds
    let w = Int32((bounds.width * scale).rounded()), h = Int32((bounds.height * scale).rounded())
    if w > 0 && h > 0 { metalLayer.drawableSize = CGSize(width: Int(w), height: Int(h)) }
    viewport.resize(w, h, scale)
    changed()
  }

  private func updateBackground() {
    let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    let v = dark ? 0.11 : 0.96
    viewport.setBackground(v, v, v)
    changed()
  }

  /// Something the picture shows has changed: draw on the next refresh.
  func changed() {
    link?.isPaused = false
  }

  // MARK: Drawing

  func metalDisplayLink(_ link: CAMetalDisplayLink, needsUpdate update: CAMetalDisplayLink.Update) {
    MainActor.assumeIsolated {
      defer { updateGizmo() }
      guard viewport.needsDraw() else {
        link.isPaused = true  // an idle window draws nothing
        return
      }
      let more = viewport.draw(Unmanaged.passUnretained(update.drawable).toOpaque())
      let state = viewport.planState()
      if state != lastPlanState {
        lastPlanState = state
        onPlanState?(state)
      }
      if !more && !viewport.needsDraw() { link.isPaused = true }
    }
  }

  // MARK: Mouse and trackpad

  private func point(_ event: NSEvent) -> NSPoint { convert(event.locationInWindow, from: nil) }

  /// The gizmo for the current tool, camera and selection, drawn again.
  func updateGizmo() {
    guard let document, tool != .select, !document.session.selection().isEmpty, bounds.width > 0 else {
      gizmo = nil
      gizmoLayer.show(nil, hovered: .None, scale: scale, appearance: effectiveAppearance)
      return
    }
    let origin = gizmoDrag?.origin ?? viewport.selectionCenter()
    let axes = gizmoDrag?.axes ?? currentAxes()
    let shape = bmapp.gizmoShape(viewport.camera(), viewSize, origin, axes, tool == .move ? .Move : .Rotate)
    gizmo = shape
    gizmoLayer.show(shape, hovered: gizmoDrag?.handle ?? hovered, scale: scale, appearance: effectiveAppearance)
  }

  private var viewSize: bmapp.Vec2 { bmapp.Vec2(x: bounds.width, y: bounds.height) }

  private func currentAxes() -> bmapp.Mat3 {
    guard localAxes, let first = document?.session.selection().first else { return bmapp.Mat3() }
    return document!.session.axesOf(first)
  }

  override func mouseMoved(with event: NSEvent) {
    guard let gizmo else { return }
    let (x, y) = fromTop(point(event))
    let h = bmapp.hitGizmo(gizmo, bmapp.Vec2(x: x, y: y), 6)
    if h != hovered {
      hovered = h
      updateGizmo()
    }
  }

  /// Starts a gizmo drag when the press is on a handle.
  private func beginGizmoDrag(_ event: NSEvent) -> Bool {
    guard let gizmo, let document else { return false }
    let (x, y) = fromTop(point(event))
    let h = bmapp.hitGizmo(gizmo, bmapp.Vec2(x: x, y: y), 6)
    guard h != .None else { return false }
    document.session.endGesture()
    gizmoDrag = GizmoDrag(handle: h, start: (x, y), origin: viewport.selectionCenter(), axes: currentAxes(), pieces: document.session.selection())
    return true
  }

  private func continueGizmoDrag(_ event: NSEvent) {
    guard var drag = gizmoDrag, let document else { return }
    let p = point(event)
    let (x, y) = fromTop(p)
    let a = bmapp.Vec2(x: drag.start.0, y: drag.start.1), b = bmapp.Vec2(x: x, y: y)
    let camera = viewport.camera()
    let pieces = drag.pieces
    if tool == .move {
      let free = event.modifierFlags.contains(.option)
      let snap = free ? bmapp.Vec3() : bmapp.Vec3(x: bmapp.kStud, y: bmapp.kPlate, z: bmapp.kStud)
      let total = bmapp.dragMove(camera, viewSize, drag.origin, drag.axes, drag.handle, a, b, snap)
      let step = bmapp.Vec3(x: total.x - drag.moved.x, y: total.y - drag.moved.y, z: total.z - drag.moved.z)
      if step.x != 0 || step.y != 0 || step.z != 0 {
        document.perform { document.session.move(pieces, step, true) }
        drag.moved = total
      }
      readout.show(DragReadout.move(total), near: p, in: self)
    } else {
      let degrees = bmapp.dragRotate(camera, viewSize, drag.origin, drag.axes, drag.handle, a, b, event.modifierFlags.contains(.shift))
      let step = degrees - drag.turned
      if step != 0 {
        let axis = bmapp.handleAxis(camera, drag.axes, drag.handle)
        let pivot = drag.origin
        document.perform { document.session.rotate(pieces, axis, step, pivot, true) }
        drag.turned = degrees
      }
      readout.show(DragReadout.angle(degrees), near: p, in: self)
    }
    gizmoDrag = drag
    changed()
  }

  private func endGizmoDrag() {
    gizmoDrag = nil
    document?.session.endGesture()
    readout.isHidden = true
    updateGizmo()
  }

  /// Points from the top left, as the viewport takes them.
  private func fromTop(_ p: NSPoint) -> (Double, Double) { (p.x, bounds.height - p.y) }

  override func mouseDown(with event: NSEvent) {
    window?.makeFirstResponder(self)
    if tool != .select && beginGizmoDrag(event) { return }
    pressPoint = point(event)
    if event.clickCount == 1, document != nil { selectionAtPress = Array(session.selection()) }
  }

  override func mouseDragged(with event: NSEvent) {
    if gizmoDrag != nil { return continueGizmoDrag(event) }
    guard let start = pressPoint else { return }
    let p = point(event)
    if marqueeLayer == nil {
      guard hypot(p.x - start.x, p.y - start.y) > 3 else { return }
      let (x, y) = fromTop(start)
      guard viewport.pick(x, y) == UInt32.max else {  // a drag that starts on a piece moves nothing: the gizmo's handles do
        pressPoint = nil
        return
      }
      let shape = CAShapeLayer()
      shape.fillColor = NSColor.controlAccentColor.withAlphaComponent(0.12).cgColor
      shape.strokeColor = NSColor.controlAccentColor.cgColor
      shape.lineWidth = 1
      shape.contentsScale = scale
      layer?.addSublayer(shape)
      marqueeLayer = shape
    }
    let rect = NSRect(x: min(start.x, p.x), y: min(start.y, p.y), width: abs(p.x - start.x), height: abs(p.y - start.y))
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    marqueeLayer?.frame = bounds
    marqueeLayer?.path = CGPath(rect: rect, transform: nil)
    marqueeLayer?.lineDashPattern = event.modifierFlags.contains(.option) ? [4, 3] : nil  // dashed: touching
    CATransaction.commit()
  }

  override func mouseUp(with event: NSEvent) {
    if gizmoDrag != nil { return endGizmoDrag() }
    defer {
      marqueeLayer?.removeFromSuperlayer()
      marqueeLayer = nil
      pressPoint = nil
    }
    guard document != nil, let start = pressPoint else { return }
    let shift = event.modifierFlags.contains(.shift)
    if marqueeLayer != nil {
      let (x0, y0) = fromTop(start), (x1, y1) = fromTop(point(event))
      let found = viewport.marquee(x0, y0, x1, y1, event.modifierFlags.contains(.option))
      session.select(found, shift ? .Add : .Replace)
      viewStateChanged()
      return
    }
    let (x, y) = fromTop(point(event))
    let piece = viewport.pick(x, y)
    if piece == UInt32.max {
      if !shift { selectNone(nil) }
      return
    }
    if event.clickCount == 2 {
      let use = Array(session.usePieces(piece))
      // The use was already the selection: open its submodel to edit it alone.
      if !shift && use.count > 1 && use.sorted() == selectionAtPress,
         let open = Registry.command("object.openSubmodel") {
        let context = CommandContext(document: document, viewport: self, clickedPiece: piece)
        session.select(Self.list(use), .Replace)
        if open.enabled(context) { return open.run(context) }
      }
      session.select(Self.list(use), shift ? .Add : .Replace)
    } else {
      session.select(Self.list([piece]), shift ? .Toggle : .Replace)
    }
    viewStateChanged()
  }

  override func rightMouseDown(with event: NSEvent) { lastPoint = point(event) }

  /// Pins a SwiftUI overlay (the breadcrumb) to the top left, below the toolbar.
  func addOverlay(_ overlay: NSView) {
    overlay.translatesAutoresizingMaskIntoConstraints = false
    addSubview(overlay)
    NSLayoutConstraint.activate([
      overlay.leadingAnchor.constraint(equalTo: safeAreaLayoutGuide.leadingAnchor, constant: 12),
      overlay.topAnchor.constraint(equalTo: safeAreaLayoutGuide.topAnchor, constant: 10),
    ])
  }

  override func rightMouseDragged(with event: NSEvent) {
    let p = point(event)
    let dx = p.x - lastPoint.x, dy = -(p.y - lastPoint.y)  // down positive
    if event.modifierFlags.contains(.shift) { viewport.pan(dx, dy) } else { viewport.orbit(dx, dy) }
    lastPoint = p
    changed()
  }

  override func otherMouseDown(with event: NSEvent) { lastPoint = point(event) }

  override func otherMouseDragged(with event: NSEvent) {
    let p = point(event)
    viewport.pan(p.x - lastPoint.x, -(p.y - lastPoint.y))
    lastPoint = p
    changed()
  }

  override func scrollWheel(with event: NSEvent) {
    if event.hasPreciseScrollingDeltas {
      // Two fingers on a trackpad: orbit; with Shift, pan.
      if event.modifierFlags.contains(.shift) {
        viewport.pan(event.scrollingDeltaX, event.scrollingDeltaY)
      } else {
        viewport.orbit(event.scrollingDeltaX, event.scrollingDeltaY)
      }
    } else if event.scrollingDeltaY != 0 {
      // A mouse wheel: zoom toward the pointer.
      let p = point(event)
      viewport.zoomToward(exp(0.1 * event.scrollingDeltaY), p.x, bounds.height - p.y)
    }
    changed()
  }

  override func magnify(with event: NSEvent) {
    let p = point(event)
    viewport.zoomToward(max(0.1, 1 + event.magnification), p.x, bounds.height - p.y)
    changed()
  }

  override func rotate(with event: NSEvent) {
    viewport.rotateGesture(Double(event.rotation))
    changed()
  }

  // MARK: Keys

  override func keyDown(with event: NSEvent) {
    if event.charactersIgnoringModifiers == " " && !event.modifierFlags.contains(.command) {
      togglePlay()
      return
    }
    if document != nil && editKey(event) { return }
    super.keyDown(with: event)
  }

  @objc func togglePlay(_ sender: Any? = nil) {
    viewport.play(!viewport.playing() && viewport.planState() != .Planning)
    changed()
  }
}

/// Hosts the viewport as the window's centre pane.
final class ViewportController: NSViewController {
  let viewportView: ViewportView

  init(session: bmapp.Session) {
    viewportView = ViewportView(session: session)
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable) required init?(coder: NSCoder) { fatalError("not from a nib") }

  override func loadView() { view = viewportView }

  override func viewDidAppear() {
    super.viewDidAppear()
    view.window?.makeFirstResponder(viewportView)
  }
}
