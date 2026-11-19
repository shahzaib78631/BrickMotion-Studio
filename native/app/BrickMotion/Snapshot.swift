// --snapshot: renders a document's whole window to a PNG without showing it, so layouts can be
// checked by a script and sent for review. The viewport's Metal picture is drawn into its rect.
import AppKit
import Darwin
import BMApp

struct SnapshotRequest {
  var output = ""
  var model = ""
  var size = NSSize(width: 1440, height: 900)
  var appearance: NSAppearance.Name? = nil
  var playTo: Double? = nil
  var report: String? = nil
  var select: [UInt32] = []
  var tool = ViewportView.Tool.select

  /// Reads `--snapshot out.png --open file [--size WxH] [--appearance light|dark] [--play-to s] [--report json] [--select n...] [--tool move|rotate]`.
  static func parse(_ args: [String]) -> SnapshotRequest? {
    guard let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count else { return nil }
    var r = SnapshotRequest()
    r.output = args[i + 1]
    func value(_ flag: String) -> String? {
      guard let j = args.firstIndex(of: flag), j + 1 < args.count else { return nil }
      return args[j + 1]
    }
    guard let model = value("--open") else { return nil }
    r.model = model
    if let s = value("--size") {
      let parts = s.split(separator: "x").compactMap { Double($0) }
      if parts.count == 2 { r.size = NSSize(width: parts[0], height: parts[1]) }
    }
    if let a = value("--appearance") { r.appearance = a == "dark" ? .darkAqua : .aqua }
    if let t = value("--play-to") { r.playTo = Double(t) }
    r.report = value("--report")
    if let t = value("--tool") { r.tool = t == "move" ? .move : t == "rotate" ? .rotate : .select }
    if let j = args.firstIndex(of: "--select") {
      r.select = args[(j + 1)...].prefix { UInt32($0) != nil }.compactMap { UInt32($0) }
    }
    return r
  }
}

enum Snapshot {
  static let scale: CGFloat = 2

  /// Runs the request and returns the process's exit status.
  @MainActor static func run(_ request: SnapshotRequest) -> Int32 {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)  // never shows, never activates
    if let a = request.appearance { app.appearance = NSAppearance(named: a) }
    let document = Document()
    do {
      try document.load(URL(fileURLWithPath: request.model))
    } catch {
      FileHandle.standardError.write("snapshot: \(error.localizedDescription)\n".data(using: .utf8)!)
      return 1
    }
    document.displayName = String(document.session.title())
    document.makeWindowControllers()
    guard let controller = document.windowControllers.first as? WindowController, let window = controller.window else { return 1 }
    window.setContentSize(request.size)
    window.layoutIfNeeded()
    let viewportView = controller.viewportController.viewportView
    let viewport = viewportView.viewport

    if !request.select.isEmpty {
      var pieces = bmapp.PieceList()
      for p in request.select { pieces.push_back(p) }
      document.session.select(pieces, .Replace)
    }
    viewportView.tool = request.tool

    if let t = request.playTo {
      viewport.play(true)
      let deadline = Date().addingTimeInterval(300)
      while viewport.planState() == .Planning || viewport.planState() == .Idle, Date() < deadline {
        _ = viewport.draw(nil)
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
      }
      viewport.play(false)
      viewport.seek(t)
    }

    // Best: the window server's own picture of the window, glass and SwiftUI included. The window
    // is ordered in far off every screen, so nothing shows; the app captures only its own window.
    if let picture = serverCapture(window, viewport: viewport, viewportView: viewportView) {
      return finish(picture, request: request, frameView: window.contentView!.superview!, controller: controller)
    }

    // The window, as AppKit draws it (titlebar and toolbar included), at 2x.
    guard let frameView = window.contentView?.superview else { return 1 }
    frameView.layoutSubtreeIfNeeded()
    let pointsWide = Int(frameView.bounds.width), pointsHigh = Int(frameView.bounds.height)
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pointsWide * Int(scale), pixelsHigh: pointsHigh * Int(scale),
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return 1 }
    rep.size = frameView.bounds.size
    guard let context = NSGraphicsContext(bitmapImageRep: rep) else { return 1 }
    // Glass and backdrop materials are drawn by the window server, which never sees this window.
    // So the picture is put together from parts: the window's background colour where the glass
    // would be, each pane's own content drawn alone, the titlebar with its toolbar, then the
    // viewport's Metal picture.
    for _ in 0..<4 { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }  // SwiftUI lays out
    frameView.layoutSubtreeIfNeeded()
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    window.effectiveAppearance.performAsCurrentDrawingAppearance {
      NSColor.windowBackgroundColor.setFill()
      frameView.bounds.fill()
      NSColor.underPageBackgroundColor.setFill()
      for pane in [controller.sidebarView, controller.inspectorView].compactMap({ $0 }) {
        pane.convert(pane.bounds, to: frameView).fill()
      }
    }
    NSGraphicsContext.restoreGraphicsState()
    var parts = [controller.sidebarView, controller.inspectorView].compactMap { $0 }
    if let titlebar = window.standardWindowButton(.closeButton)?.superview?.superview { parts.append(titlebar) }
    for part in parts { composite(part, into: rep, frameView: frameView) }

    // The viewport's own picture, drawn at the same scale into its rect.
    let vRect = viewportView.convert(viewportView.bounds, to: frameView)
    viewport.resize(Int32(vRect.width * scale), Int32(vRect.height * scale), Double(scale))
    var picture = viewport.readback()
    for _ in 0..<64 {  // maps drawn over frames settle within a few
      let more = viewport.draw(nil)
      picture = viewport.readback()
      if !more { break }
    }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    if let cg = cgImage(picture) {
      // AppKit's frame view is flipped or not; the rect is in its own coordinates.
      let flipped = frameView.isFlipped
      let y = flipped ? frameView.bounds.height - vRect.maxY : vRect.minY
      context.cgContext.draw(cg, in: CGRect(x: vRect.minX, y: y, width: vRect.width, height: vRect.height))
    }
    NSGraphicsContext.restoreGraphicsState()

    return finish(rep, request: request, frameView: frameView, controller: controller)
  }

  @MainActor private static func finish(_ rep: NSBitmapImageRep, request: SnapshotRequest, frameView: NSView,
                                        controller: WindowController) -> Int32 {
    guard let png = rep.representation(using: .png, properties: [:]) else { return 1 }
    do {
      try png.write(to: URL(fileURLWithPath: request.output))
    } catch {
      FileHandle.standardError.write("snapshot: \(error.localizedDescription)\n".data(using: .utf8)!)
      return 1
    }
    if let report = request.report {
      writeReport(report, frameView: frameView, controller: controller)
    }
    return 0
  }

  private typealias WindowImage = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?

  /// The window as the window server composites it, or nil where that is not available.
  @MainActor private static func serverCapture(_ window: NSWindow, viewport: bmapp.Viewport, viewportView: ViewportView) -> NSBitmapImageRep? {
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else { return nil }
    let windowImage = unsafeBitCast(symbol, to: WindowImage.self)
    let size = window.frame.size
    window.setFrameOrigin(NSPoint(x: -20000 - size.width, y: -20000 - size.height))
    window.alphaValue = 1
    window.orderFrontRegardless()
    // Draw until the viewport settles and SwiftUI has laid out, then a few frames more.
    let deadline = Date().addingTimeInterval(20)
    var quiet = 0
    while quiet < 6, Date() < deadline {
      RunLoop.main.run(until: Date().addingTimeInterval(1.0 / 30))
      quiet = viewport.needsDraw() ? 0 : quiet + 1
    }
    viewportView.changed()
    viewportView.updateGizmo()
    RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    // .optionIncludingWindow, .boundsIgnoreFraming | .bestResolution
    let image = windowImage(.null, 1 << 3, UInt32(window.windowNumber), (1 << 0) | (1 << 3))?.takeRetainedValue()
    window.orderOut(nil)
    guard let cg = image, cg.width > 0 else { return nil }
    // Only a real picture counts: a capture the system refused comes back blank.
    let rep = NSBitmapImageRep(cgImage: cg)
    rep.size = size
    return isBlank(rep) ? nil : rep
  }

  private static func isBlank(_ rep: NSBitmapImageRep) -> Bool {
    var seen = Set<UInt32>()
    for y in stride(from: 0, to: rep.pixelsHigh, by: 37) {
      for x in stride(from: 0, to: rep.pixelsWide, by: 37) {
        guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
        seen.insert(UInt32(c.redComponent * 255) << 16 | UInt32(c.greenComponent * 255) << 8 | UInt32(c.blueComponent * 255))
        if seen.count > 8 { return false }
      }
    }
    return true
  }

  /// Draws `view` alone (AppKit's own drawing, without what lies behind it) over `rep` at its place.
  @MainActor private static func composite(_ view: NSView, into rep: NSBitmapImageRep, frameView: NSView) {
    guard view.bounds.width > 0, view.bounds.height > 0,
          let own = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
    view.cacheDisplay(in: view.bounds, to: own)
    let r = view.convert(view.bounds, to: frameView)
    let y = frameView.isFlipped ? frameView.bounds.height - r.maxY : r.minY
    guard let context = NSGraphicsContext(bitmapImageRep: rep) else { return }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    own.draw(in: NSRect(x: r.minX, y: y, width: r.width, height: r.height), from: .zero, operation: .sourceOver,
             fraction: 1, respectFlipped: false, hints: nil)
    NSGraphicsContext.restoreGraphicsState()
  }

  /// The rects of the window's parts, in pixels from the top left, as JSON.
  @MainActor private static func writeReport(_ path: String, frameView: NSView, controller: WindowController) {
    func pixels(_ view: NSView) -> [Double] {
      let r = view.convert(view.bounds, to: frameView)
      let top = frameView.isFlipped ? r.minY : frameView.bounds.height - r.maxY
      return [Double(r.minX * scale), Double(top * scale), Double(r.width * scale), Double(r.height * scale)]
    }
    var rects: [String: [Double]] = ["window": pixels(frameView)]
    rects["viewport"] = pixels(controller.viewportController.viewportView)
    if let sidebar = controller.sidebarView { rects["sidebar"] = pixels(sidebar) }
    if let inspector = controller.inspectorView { rects["inspector"] = pixels(inspector) }
    if let data = try? JSONSerialization.data(withJSONObject: rects, options: [.sortedKeys]) {
      try? data.write(to: URL(fileURLWithPath: path))
    }
  }

  private static func cgImage(_ p: bmapp.Picture) -> CGImage? {
    let w = Int(p.width), h = Int(p.height)
    guard w > 0, h > 0, p.rgba.size() == w * h * 4 else { return nil }
    var bytes = [UInt8](repeating: 0, count: w * h * 4)
    for i in 0..<bytes.count { bytes[i] = p.rgba[i] }
    guard let provider = CGDataProvider(data: Data(bytes) as CFData) else { return nil }
    return CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4,
                   space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                   provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
  }
}
