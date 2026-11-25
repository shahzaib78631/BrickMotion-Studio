// The Metal viewport: a CAMetalLayer drawn by bmapp.Viewport only when something changed.
// Click selects (Shift toggles, double-click takes a submodel's whole use, and a double click on
// a use already selected opens its submodel), a drag on empty space
// marquees (Option: touching), right-drag or two-finger scroll orbits, Shift pans, pinch zooms,
// rotate turns; Space plays. The editing keys are in EditCommands.swift.
import AppKit
import BMApp
import QuartzCore
import SwiftUI

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
  @objc private func documentChanged(_ note: Notification) {
    placement.modelChanged()
    changed()
  }
  private var pressPoint: NSPoint?
  /// A waiting piece being dragged across the floor in the Build preview (saved on mouse-up).
  private var waitingDrag: UInt32?
  /// A flight path point being dragged: where it was (studs, the keys' own units, and LDU) and
  /// where the press began.
  private struct PathDrag {
    let piece: UInt32
    let frame: Int32
    let origin: bmapp.Vec3
    let through: bmapp.Vec3
    let start: (x: Double, y: Double)
  }
  private var pathDrag: PathDrag?
  /// The path point last clicked: Delete removes it.
  private var focusedPathPoint: (piece: UInt32, frame: Int32)?
  /// The selection as a click began: a double click on a use already selected opens it.
  private var selectionAtPress: [UInt32] = []
  /// A right-button press that has not dragged yet: its release opens the context menu.
  private var rightDragged = false
  private var marqueeLayer: CAShapeLayer?

  // MARK: Tools

  enum Tool: Int { case select, move, rotate, scale }
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
    var scale = bmapp.Vec3(x: 1, y: 1, z: 1)
    var key: KeyDrag?
  }
  private struct KeyDrag {
    let piece: UInt32
    let submodel: Bool
    let frame: Int32
    let origin: bmapp.Vec3
  }
  private var gizmoDrag: GizmoDrag?
  /// Called on the main thread when planning starts or ends, for the toolbar's progress.
  weak var animation: AnimationWorkspace?
  var presentedFrame: (@Sendable (CFTimeInterval) -> Void)?
  let presentation = ViewportPresentation()
  private var link: CAMetalDisplayLink?
  private var lastPoint = NSPoint.zero
  lazy var placement = PlacementController(view: self)
  var collisionChecks = true { didSet { placement.collisionChanged(collisionChecks) } }
  private let placementGrip = CAShapeLayer()
  private var partDragSequence: Int?
  private var editorOverlays: EditorOverlays?
  private var orbiting = false

  init(session: bmapp.Session) {
    viewport = bmapp.Viewport.create(session)!
    super.init(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
    presentation.view = self
    wantsLayer = true
    layerContentsRedrawPolicy = .never
    setAccessibilityRole(.group)
    setAccessibilityLabel("Model viewport")
    addSubview(readout)
    let hud = NSHostingView(rootView: PlacementHUD(controller: placement))
    hud.sizingOptions = [.intrinsicContentSize]
    hud.translatesAutoresizingMaskIntoConstraints = false
    addSubview(hud)
    NSLayoutConstraint.activate([
      hud.centerXAnchor.constraint(equalTo: safeAreaLayoutGuide.centerXAnchor),
      hud.bottomAnchor.constraint(equalTo: safeAreaLayoutGuide.bottomAnchor, constant: -16),
      hud.widthAnchor.constraint(lessThanOrEqualTo: safeAreaLayoutGuide.widthAnchor, constant: -24)
    ])
    placementGrip.isHidden = true
    layer?.addSublayer(placementGrip)
    registerForDraggedTypes([PartDragItem.type])
    preferencesChanged()
    NotificationCenter.default.addObserver(self, selector: #selector(preferencesChanged),
                                           name: EditorPreferences.didChange, object: EditorPreferences.shared)
    addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self))
  }

  @objc private func preferencesChanged() {
    viewport.setPreferences(EditorPreferences.shared.viewport)
    updateEditorOverlays()
    changed()
  }

  func installEditorOverlays(model: DocumentModel) {
    editorOverlays = EditorOverlays(view: self, model: model)
  }

  func updateEditorOverlays() {
    editorOverlays?.update(suppressed: orbiting || placement.active || viewport.playing())
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
    NotificationCenter.default.removeObserver(self, name: NSWindow.didResignMainNotification, object: nil)
    guard let window else {
      placement.cancel()
      link?.invalidate()
      link = nil
      return
    }
    NotificationCenter.default.addObserver(self, selector: #selector(windowResignedMain),
                                           name: NSWindow.didResignMainNotification, object: window)
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

  @objc private func windowResignedMain() {
    if partDragSequence == nil { placement.cancel() }
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
    placement.moveWithCamera()
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
      defer { updateGizmo(); updateEditorOverlays() }
      guard viewport.needsDraw() else {
        link.isPaused = true  // an idle window draws nothing
        return
      }
      if let presentedFrame {
        update.drawable.addPresentedHandler { drawable in presentedFrame(drawable.presentedTime) }
      }
      let more = viewport.draw(Unmanaged.passUnretained(update.drawable).toOpaque())
      if placement.active {
        let preview = viewport.placementPreview()
        placement.receive(preview)
        updatePlacementGrip(placement.active ? preview : bmapp.PlacementPreview())
      } else if !placementGrip.isHidden {
        updatePlacementGrip(bmapp.PlacementPreview())
      }
      animation?.update()
      presentation.update()
      if !more && !viewport.needsDraw() { link.isPaused = true }
    }
  }

  // MARK: Mouse and trackpad

  private func point(_ event: NSEvent) -> NSPoint { convert(event.locationInWindow, from: nil) }

  /// The gizmo for the current tool, camera and selection, drawn again.
  func updateGizmo() {
    guard let document, !placement.active, tool != .select, !document.session.selection().isEmpty, bounds.width > 0 else {
      gizmo = nil
      gizmoLayer.show(nil, hovered: .None, scale: scale, appearance: effectiveAppearance)
      return
    }
    let origin = gizmoDrag?.origin ?? viewport.selectionCenter()
    let axes = gizmoDrag?.axes ?? currentAxes()
    let shape = bmapp.gizmoShape(viewport.camera(), viewSize, origin, axes, tool == .rotate ? .Rotate : .Move)
    gizmo = shape
    gizmoLayer.show(shape, hovered: gizmoDrag?.handle ?? hovered, scale: scale, appearance: effectiveAppearance, squareTips: tool == .scale)
  }

  private var viewSize: bmapp.Vec2 { bmapp.Vec2(x: bounds.width, y: bounds.height) }

  private func currentAxes() -> bmapp.Mat3 {
    if animation?.isKeyEditing == true { return bmapp.Mat3() }
    guard localAxes, let first = document?.session.selection().first else { return bmapp.Mat3() }
    return document!.session.axesOf(first)
  }

  override func mouseMoved(with event: NSEvent) {
    if placement.active {
      placement.move(to: point(event), option: event.modifierFlags.contains(.option))
      return
    }
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
    let pieces = document.session.selection()
    var drag = GizmoDrag(handle: h, start: (x, y), origin: viewport.selectionCenter(), axes: currentAxes(), pieces: pieces)
    if let animation, animation.isKeyEditing {
      let target = bmapp.autoKeyTarget(session, pieces, animation.autoKey, animation.keySubmodel.map { Int64($0) } ?? -1)
      guard target.ok else {
        NSSound.beep()
        return true
      }
      let piece = target.piece, submodel = target.submodel
      let scene = session.keyScene()
      animation.seekScene(animation.time)
      let frame = scene.first + Int32((animation.time * Double(scene.fps)).rounded())
      let channels: [bmapp.KeyChannel] = switch tool {
      case .move: [.PositionX, .PositionY, .PositionZ]
      case .scale: [.ScaleX, .ScaleY, .ScaleZ]
      default: [.RotationX, .RotationY, .RotationZ]
      }
      let values = channels.map { session.keyValue(piece, $0, Double(frame), submodel) }
      drag.key = KeyDrag(piece: piece, submodel: submodel, frame: frame,
                         origin: bmapp.Vec3(x: values[0], y: values[1], z: values[2]))
    }
    gizmoDrag = drag
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
        if let key = drag.key {
          write(drag: key, tool: .Move, change: total, document: document)
        } else {
          document.perform { document.session.move(pieces, step, true) }
        }
        drag.moved = total
      }
      readout.show(DragReadout.move(total), near: p, in: self)
    } else if tool == .scale {
      let heading = gizmo?.lines.first { $0.h == drag.handle }
      let dx = x - drag.start.0, dy = y - drag.start.1
      let along: Double
      if let heading {
        let hx = heading.b.x - heading.a.x, hy = heading.b.y - heading.a.y
        along = (dx * hx + dy * hy) / max(1, hypot(hx, hy))
      } else {
        along = (dx - dy) / sqrt(2)
      }
      var factor = pow(2, min(3, max(-3, along / 84)))
      if event.modifierFlags.contains(.shift) { factor = (factor * 20).rounded() / 20 }
      let f = scaleFactors(drag.handle, factor)
      let delta = bmapp.Vec3(x: f.x / drag.scale.x, y: f.y / drag.scale.y, z: f.z / drag.scale.z)
      if f.x != drag.scale.x || f.y != drag.scale.y || f.z != drag.scale.z {
        if let key = drag.key {
          write(drag: key, tool: .Scale, change: f, document: document)
        } else {
          let axes = drag.axes, pivot = drag.origin
          document.perform { document.session.scale(pieces, delta, axes, pivot, true) }
        }
        drag.scale = f
      }
      readout.show(factor.formatted(.percent.precision(.fractionLength(0))), near: p, in: self)
    } else {
      let degrees = bmapp.dragRotate(camera, viewSize, drag.origin, drag.axes, drag.handle, a, b, event.modifierFlags.contains(.shift))
      let step = degrees - drag.turned
      if step != 0 {
        let axis = bmapp.handleAxis(camera, drag.axes, drag.handle)
        let pivot = drag.origin
        if let key = drag.key {
          write(drag: key, tool: .Rotate, change: bmapp.Vec3(x: axis.x * degrees, y: axis.y * degrees, z: axis.z * degrees),
                document: document)
        } else {
          document.perform { document.session.rotate(pieces, axis, step, pivot, true) }
        }
        drag.turned = degrees
      }
      readout.show(DragReadout.angle(degrees), near: p, in: self)
    }
    gizmoDrag = drag
    changed()
  }

  private func scaleFactors(_ handle: bmapp.Handle, _ value: Double) -> bmapp.Vec3 {
    bmapp.Vec3(x: [.X, .XY, .XZ].contains(handle) ? value : 1,
               y: [.Y, .XY, .YZ].contains(handle) ? value : 1,
               z: [.Z, .XZ, .YZ].contains(handle) ? value : 1)
  }

  private func write(drag: KeyDrag, tool: bmapp.GizmoTool, change: bmapp.Vec3, document: Document) {
    let keys = bmapp.autoKeyValues(tool, drag.origin, change, drag.frame)
    document.perform { document.session.setKeys(drag.piece, keys, true, drag.submodel) }
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
    if placement.active { return }
    if event.modifierFlags.contains(.control) { return showMenu(event) }
    if editorOverlays?.selectJoint(at: point(event)) == true { return }
    if beginPathEdit(event) { return }
    focusedPathPoint = nil
    if tool != .select && beginGizmoDrag(event) { return }
    pressPoint = point(event)
    if event.clickCount == 1, document != nil { selectionAtPress = Array(session.selection()) }
  }

  override func mouseDragged(with event: NSEvent) {
    if placement.active {
      placement.move(to: point(event), option: event.modifierFlags.contains(.option))
      return
    }
    if gizmoDrag != nil { return continueGizmoDrag(event) }
    if let drag = pathDrag, let document {
      let (x, y) = fromTop(point(event))
      let d = viewport.dragFacingView(drag.through, drag.start.x, drag.start.y, x, y)
      // LDU to the keys' studs (y and z flip: the web's axes)
      let location = bmapp.Vec3(x: drag.origin.x + d.x / 20, y: drag.origin.y - d.y / 20, z: drag.origin.z - d.z / 20)
      document.perform { document.session.setFlightPathPoint(drag.piece, drag.frame, location, true) }
      changed()
      return
    }
    if waitingDrag != nil {
      let (x, y) = fromTop(point(event))
      _ = viewport.dragWaitingPart(x, y)
      changed()
      return
    }
    guard let start = pressPoint else { return }
    let p = point(event)
    if marqueeLayer == nil {
      guard hypot(p.x - start.x, p.y - start.y) > 3 else { return }
      let (x, y) = fromTop(start)
      let anchor = viewport.pick(x, y)
      // In the Build preview a piece still waiting on the floor is dragged to a new waiting spot
      // (the web's staging drag): it still lands as planned, and nothing is replanned.
      if anchor != UInt32.max, viewport.canMoveWaitingPart(anchor), viewport.beginWaitingDrag(anchor, x, y) {
        pressPoint = nil
        waitingDrag = anchor
        if Array(session.selection()) != [anchor] { select([anchor], .Replace) }
        NSCursor.closedHand.push()
        let (px, py) = fromTop(p)
        _ = viewport.dragWaitingPart(px, py)
        changed()
        return
      }
      if anchor != UInt32.max {
        if animation?.isKeyEditing == true { return }
        let pieces = selectionAtPress.contains(anchor) ? selectionAtPress : [anchor]
        if pieces != Array(session.selection()) { select(pieces, .Replace) }
        pressPoint = nil
        placement.beginMove(piece: anchor, selection: pieces, from: start, to: p,
                            option: event.modifierFlags.contains(.option))
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
    if placement.active {
      if !event.modifierFlags.contains(.control) {
        if bounds.contains(point(event)) {
          placement.move(to: point(event), option: event.modifierFlags.contains(.option))
          placement.accept()
        } else {
          placement.cancel()
        }
      }
      return
    }
    if gizmoDrag != nil { return endGizmoDrag() }
    if pathDrag != nil {
      pathDrag = nil
      document?.session.endGesture()
      NSCursor.pop()
      return changed()
    }
    if let piece = waitingDrag { return endWaitingDrag(piece, keep: true) }
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

  /// A press on the selected part's flight path (key editing): on a point it seeks there and starts
  /// the point's drag; on the line it is taken by the path, and a double-click adds a point there.
  private func beginPathEdit(_ event: NSEvent) -> Bool {
    guard let overlays = editorOverlays, let animation, animation.isKeyEditing, let document else { return false }
    let p = point(event)
    let scene = session.keyScene()
    if let hit = overlays.flightPathPoint(at: p) {
      document.session.endGesture()
      animation.seekScene(Double(hit.frame - scene.first) / Double(scene.fps))
      focusedPathPoint = (hit.piece, hit.frame)
      let origin = bmapp.Vec3(x: session.keyValue(hit.piece, .PositionX, Double(hit.frame)),
                              y: session.keyValue(hit.piece, .PositionY, Double(hit.frame)),
                              z: session.keyValue(hit.piece, .PositionZ, Double(hit.frame)))
      let (x, y) = fromTop(p)
      pathDrag = PathDrag(piece: hit.piece, frame: hit.frame, origin: origin, through: hit.at, start: (x, y))
      NSCursor.closedHand.push()
      changed()
      return true
    }
    guard let (piece, frame) = overlays.flightPathFrame(at: p) else { return false }
    // a click on the line belongs to the path (the selection stays); a double-click adds a point
    guard event.clickCount == 2 else { return true }
    let added = document.perform { document.session.addFlightPathPoint(piece, frame) }
    if !added.refused.empty() { NSSound.beep(); return true }
    animation.seekScene(Double(frame - scene.first) / Double(scene.fps))
    focusedPathPoint = (piece, frame)
    changed()
    return true
  }

  /// Deletes a path point (never the first or the last).
  private func deletePathPoint(_ piece: UInt32, _ frame: Int32) {
    guard let document else { return }
    let deleted = document.perform { document.session.deleteFlightPathPoint(piece, frame) }
    if !deleted.refused.empty() { NSSound.beep() }
    focusedPathPoint = nil
    changed()
  }

  /// Ends a waiting piece's drag: kept, it is one undo step ("Move Waiting Part").
  private func endWaitingDrag(_ piece: UInt32, keep: Bool) {
    waitingDrag = nil
    NSCursor.pop()
    let delta = viewport.endWaitingDrag()
    if keep, hypot(delta.x, delta.z) > 0.01, let document {
      let changed = document.perform { document.session.shiftWaitingPart(piece, delta) }
      if !changed.refused.empty() { NSSound.beep() }
    }
    changed()
  }

  override func rightMouseDown(with event: NSEvent) {
    lastPoint = point(event)
    rightDragged = false
  }

  override func rightMouseUp(with event: NSEvent) {
    orbiting = false
    updateEditorOverlays()
    if !rightDragged && !placement.active { showMenu(event) }
  }

  /// The piece menu for a piece under the pointer (selected first when it is not already), or the
  /// empty-space menu.
  override func menu(for event: NSEvent) -> NSMenu? {
    guard document != nil, !placement.active else { return nil }
    if let menu = pathMenu(for: event) { return menu }
    let (x, y) = fromTop(point(event))
    let hit = viewport.pick(x, y)
    let piece: UInt32? = hit == UInt32.max ? nil : hit
    if let piece, !session.selection().contains(piece) { select([piece], .Replace) }
    return PieceMenu.make(piece: piece, context: CommandContext(document: document, viewport: self, clickedPiece: piece))
  }

  /// The menu for the selected part's flight path, when the click is on a point or on the line.
  private func pathMenu(for event: NSEvent) -> NSMenu? {
    guard let overlays = editorOverlays, animation?.isKeyEditing == true else { return nil }
    let p = point(event)
    let menu = NSMenu()
    if let hit = overlays.flightPathPoint(at: p) {
      let item = menu.addItem(withTitle: "Delete Path Point", action: #selector(deletePathPointItem(_:)), keyEquivalent: "")
      item.representedObject = [hit.piece, UInt32(bitPattern: hit.frame)]
      item.target = self
      return menu
    }
    if let (piece, frame) = overlays.flightPathFrame(at: p) {
      let item = menu.addItem(withTitle: "Add Path Point", action: #selector(addPathPointItem(_:)), keyEquivalent: "")
      item.representedObject = [piece, UInt32(bitPattern: frame)]
      item.target = self
      return menu
    }
    return nil
  }

  @objc private func deletePathPointItem(_ item: NSMenuItem) {
    guard let pair = item.representedObject as? [UInt32], pair.count == 2 else { return }
    deletePathPoint(pair[0], Int32(bitPattern: pair[1]))
  }

  @objc private func addPathPointItem(_ item: NSMenuItem) {
    guard let pair = item.representedObject as? [UInt32], pair.count == 2, let document else { return }
    let added = document.perform { document.session.addFlightPathPoint(pair[0], Int32(bitPattern: pair[1])) }
    if !added.refused.empty() { NSSound.beep() }
    changed()
  }

  private func showMenu(_ event: NSEvent) {
    window?.makeFirstResponder(self)
    if let menu = menu(for: event) { NSMenu.popUpContextMenu(menu, with: event, for: self) }
  }

  /// Pins a SwiftUI overlay (the breadcrumb) to the top left, below the toolbar.
  func addOverlay(_ overlay: NSView, leading: Bool = true, top: Bool = true) {
    overlay.translatesAutoresizingMaskIntoConstraints = false
    addSubview(overlay)
    NSLayoutConstraint.activate([
      leading ? overlay.leadingAnchor.constraint(equalTo: safeAreaLayoutGuide.leadingAnchor, constant: 12)
        : overlay.trailingAnchor.constraint(equalTo: safeAreaLayoutGuide.trailingAnchor, constant: -12),
      top ? overlay.topAnchor.constraint(equalTo: safeAreaLayoutGuide.topAnchor, constant: 10)
        : overlay.bottomAnchor.constraint(equalTo: safeAreaLayoutGuide.bottomAnchor, constant: -10),
    ])
  }

  override func rightMouseDragged(with event: NSEvent) {
    rightDragged = true
    orbiting = true
    let p = point(event)
    let dx = p.x - lastPoint.x, dy = -(p.y - lastPoint.y)  // down positive
    if event.modifierFlags.contains(.shift) { viewport.pan(dx, dy) } else { viewport.orbit(dx, dy) }
    lastPoint = p
    placement.moveWithCamera()
    changed()
  }

  override func otherMouseDown(with event: NSEvent) { lastPoint = point(event) }

  override func otherMouseDragged(with event: NSEvent) {
    let p = point(event)
    viewport.pan(p.x - lastPoint.x, -(p.y - lastPoint.y))
    lastPoint = p
    placement.moveWithCamera()
    changed()
  }

  override func scrollWheel(with event: NSEvent) {
    if event.hasPreciseScrollingDeltas {
      orbiting = event.phase == .began || event.phase == .changed ||
        event.momentumPhase == .began || event.momentumPhase == .changed
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
    updateEditorOverlays()
    placement.moveWithCamera()
    changed()
  }

  override func magnify(with event: NSEvent) {
    let p = point(event)
    viewport.zoomToward(max(0.1, 1 + event.magnification), p.x, bounds.height - p.y)
    placement.moveWithCamera()
    changed()
  }

  override func rotate(with event: NSEvent) {
    viewport.rotateGesture(Double(event.rotation))
    placement.moveWithCamera()
    changed()
  }

  // MARK: Keys

  override func keyDown(with event: NSEvent) {
    if let piece = waitingDrag, event.keyCode == 53 { return endWaitingDrag(piece, keep: false) }  // Esc: put it back
    if let focus = focusedPathPoint, animation?.isKeyEditing == true, [51, 117].contains(event.keyCode),
       event.modifierFlags.intersection([.command, .control, .option]).isEmpty,
       Array(session.selection()) == [focus.piece] {
      return deletePathPoint(focus.piece, focus.frame)
    }
    if placement.active && event.modifierFlags.intersection([.command, .control]).isEmpty {
      let distance = event.modifierFlags.contains(.shift) ? 32.0 : 12.0
      switch event.keyCode {
      case 53: placement.cancel(); return
      case 36, 76: placement.accept(); return
      case 48: placement.cycleGrip(back: event.modifierFlags.contains(.shift)); return
      case 123: placement.nudge(x: -distance, y: 0); return
      case 124: placement.nudge(x: distance, y: 0); return
      case 125: placement.nudge(x: 0, y: -distance); return
      case 126: placement.nudge(x: 0, y: distance); return
      default:
        if event.charactersIgnoringModifiers?.lowercased() == "r" { placement.turn(); return }
      }
    }
    if event.charactersIgnoringModifiers == " " && !event.modifierFlags.contains(.command) {
      togglePlay()
      return
    }
    if let animation, animation.isKeyEditing, let document,
       event.modifierFlags.intersection([.command, .control, .option]).isEmpty {
      let step = Double(event.modifierFlags.contains(.shift) ? 10 : 1) / Double(document.session.keyScene().fps)
      switch event.keyCode {
      case 123: animation.seekScene(animation.time - step); return
      case 124: animation.seekScene(animation.time + step); return
      case 115: animation.seekScene(0); return
      case 119: animation.seekScene(animation.duration); return
      default: break
      }
    }
    if document != nil && editKey(event) { return }
    super.keyDown(with: event)
  }

  @objc func togglePlay(_ sender: Any? = nil) {
    placement.cancel()
    if let animation, let controller = window?.windowController as? WindowController {
      controller.setAnimateMode(true, plan: false)
      animation.togglePlayback()
    } else {
      viewport.play(!viewport.playing() && viewport.planState() != .Planning)
      changed()
    }
  }

  override func flagsChanged(with event: NSEvent) {
    placement.optionChanged(event.modifierFlags.contains(.option))
    super.flagsChanged(with: event)
  }

  override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
    guard let item = PartDragItem.read(sender.draggingPasteboard) else { return [] }
    placement.begin(item.part, colour: item.colour, turns: item.turns, mirrored: item.mirrored, step: nil,
                    reference: item.reference,
                    at: convert(sender.draggingLocation, from: nil))
    guard placement.active else { return [] }
    partDragSequence = sender.draggingSequenceNumber
    return .copy
  }

  override func draggingUpdated(_ sender: any NSDraggingInfo) -> NSDragOperation {
    guard partDragSequence == sender.draggingSequenceNumber, placement.active else { return [] }
    placement.move(to: convert(sender.draggingLocation, from: nil), option: NSEvent.modifierFlags.contains(.option))
    return .copy
  }

  override func draggingExited(_ sender: (any NSDraggingInfo)?) {
    guard let sender, partDragSequence == sender.draggingSequenceNumber else { return }
    partDragSequence = nil
    placement.cancel()
  }

  override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
    guard partDragSequence == sender.draggingSequenceNumber, placement.active else { return false }
    partDragSequence = nil
    placement.move(to: convert(sender.draggingLocation, from: nil), option: NSEvent.modifierFlags.contains(.option))
    placement.accept()
    return true
  }

  private func updatePlacementGrip(_ preview: bmapp.PlacementPreview) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    defer { CATransaction.commit() }
    guard preview.state == .Snapped || preview.state == .Reference else {
      placementGrip.isHidden = true
      return
    }
    let point = bmapp.projectPoint(viewport.camera(), viewSize, preview.contact)
    guard point.x.isFinite, point.y.isFinite else {
      placementGrip.isHidden = true
      return
    }
    placementGrip.frame = bounds
    placementGrip.path = CGPath(ellipseIn: CGRect(x: point.x - 5, y: bounds.height - point.y - 5, width: 10, height: 10),
                                transform: nil)
    placementGrip.lineWidth = 1.5
    placementGrip.strokeColor = NSColor.white.cgColor
    placementGrip.fillColor = NSColor.controlAccentColor.cgColor
    placementGrip.contentsScale = scale
    placementGrip.isHidden = false
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
