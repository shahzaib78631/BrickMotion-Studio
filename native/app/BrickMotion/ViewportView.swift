// The Metal viewport: a CAMetalLayer drawn by bmapp.Viewport only when something changed.
// Right-drag or two-finger scroll orbits, Shift pans, pinch zooms, rotate turns; Space plays.
import AppKit
import BMApp
import QuartzCore

final class ViewportView: NSView, @preconcurrency CAMetalDisplayLinkDelegate {
  let viewport: bmapp.Viewport
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

  private var scale: Double { Double(window?.backingScaleFactor ?? 2) }

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
    guard let key = event.charactersIgnoringModifiers?.lowercased(), !event.modifierFlags.contains(.command) else {
      super.keyDown(with: event)
      return
    }
    switch key {
    case " ": togglePlay()
    case "f": viewport.fitAll()
    default: super.keyDown(with: event)
    }
    changed()
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
