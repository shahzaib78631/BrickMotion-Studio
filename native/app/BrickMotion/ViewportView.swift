// The Metal viewport: a CAMetalLayer drawn by bmapp.Viewport only when something changed.
// Click selects (Shift toggles, double-click takes a submodel's whole use), a drag on empty space
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
  private var marqueeLayer: CAShapeLayer?
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

  /// Points from the top left, as the viewport takes them.
  private func fromTop(_ p: NSPoint) -> (Double, Double) { (p.x, bounds.height - p.y) }

  override func mouseDown(with event: NSEvent) {
    window?.makeFirstResponder(self)
    pressPoint = point(event)
  }

  override func mouseDragged(with event: NSEvent) {
    guard let start = pressPoint else { return }
    let p = point(event)
    if marqueeLayer == nil {
      guard hypot(p.x - start.x, p.y - start.y) > 3 else { return }
      let (x, y) = fromTop(start)
      guard viewport.pick(x, y) == UInt32.max else {  // a drag that starts on a piece is the gizmos' (Task 11)
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
      session.select(session.usePieces(piece), shift ? .Add : .Replace)
    } else {
      session.select(Self.list([piece]), shift ? .Toggle : .Replace)
    }
    viewStateChanged()
  }

  override func rightMouseDown(with event: NSEvent) { lastPoint = point(event) }

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
