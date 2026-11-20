// --snapshot: renders a document's whole window to a PNG without showing it, so layouts can be
// checked by a script and sent for review. The viewport's Metal picture is drawn into its rect.
import AppKit
import Darwin
import BMApp

struct SnapshotRequest {
  var output = ""
  var model = ""
  var blank = false
  var size = NSSize(width: 1440, height: 900)
  var appearance: NSAppearance.Name? = nil
  var playTo: Double? = nil
  var report: String? = nil
  var select: [UInt32] = []
  var tool = ViewportView.Tool.select
  var sidebar: SidebarTab? = nil
  var partsQuery: String? = nil
  var placement: String? = nil
  var placementAt = NSPoint(x: 0.5, y: 0.5)
  var focus: [String] = []
  var expandAll = false
  var editStep: Int? = nil
  var inspector: InspectorTab? = nil
  var palette: String? = nil
  var animation: TimelineTab?
  var orthographic = false
  var grid: Double?

  /// Reads `--snapshot out.png --open file [--size WxH] [--appearance light|dark] [--play-to s] [--report json] [--select n...] [--tool move|rotate]
  /// [--sidebar models|steps|parts] [--parts-query "query"] [--focus Name[/Name]] [--expand all] [--edit-step N] [--inspector selection|part|submodel]
  /// [--palette "query"]`.
  static func parse(_ args: [String]) -> SnapshotRequest? {
    guard let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count else { return nil }
    var r = SnapshotRequest()
    r.output = args[i + 1]
    func value(_ flag: String) -> String? {
      guard let j = args.firstIndex(of: flag), j + 1 < args.count else { return nil }
      return args[j + 1]
    }
    if let model = value("--open") { r.model = model }
    else if args.contains("--new") { r.blank = true }
    else { return nil }
    if let s = value("--size") {
      let parts = s.split(separator: "x").compactMap { Double($0) }
      if parts.count == 2 { r.size = NSSize(width: parts[0], height: parts[1]) }
    }
    if let a = value("--appearance") { r.appearance = a == "dark" ? .darkAqua : .aqua }
    if let t = value("--play-to") { r.playTo = Double(t) }
    r.report = value("--report")
    if let s = value("--sidebar") { r.sidebar = SidebarTab(rawValue: s) }
    r.partsQuery = value("--parts-query")
    r.placement = value("--placement")
    if let raw = value("--placement-at") {
      let xy = raw.split(separator: ",").compactMap { Double($0) }
      if xy.count == 2, xy.allSatisfy({ (0...1).contains($0) }) { r.placementAt = NSPoint(x: xy[0], y: xy[1]) }
    }
    if let f = value("--focus") { r.focus = f.split(separator: "/").map(String.init) }
    r.expandAll = value("--expand") == "all"
    if let k = value("--edit-step") { r.editStep = Int(k) }
    if let i = value("--inspector") { r.inspector = InspectorTab(rawValue: i) }
    r.palette = value("--palette")
    if let tab = value("--animate") { r.animation = TimelineTab.allCases.first { $0.rawValue.lowercased() == tab.lowercased() } }
    r.orthographic = args.contains("--orthographic")
    if let grid = value("--grid") { r.grid = Double(grid) }
    if let t = value("--tool") { r.tool = t == "move" ? .move : t == "rotate" ? .rotate : t == "scale" ? .scale : .select }
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
      if request.blank { try document.prepareBlank() }
      else { try document.load(URL(fileURLWithPath: request.model)) }
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
    if request.orthographic { viewportView.presentation.orthographic = true }
    if let grid = request.grid { viewportView.presentation.grid = grid }
    if let tab = request.animation {
      controller.setAnimateMode(true, plan: false)
      controller.model.animation.tab = tab
      window.layoutIfNeeded()
    }

    if !request.select.isEmpty {
      var pieces = bmapp.PieceList()
      for p in request.select { pieces.push_back(p) }
      document.session.select(pieces, .Replace)
    }
    viewportView.tool = request.tool
    if let tab = request.sidebar { controller.model.sidebarTab = tab }
    if let query = request.partsQuery {
      controller.model.sidebarTab = .parts
      controller.model.partsQuery = query
    }
    if request.expandAll { controller.model.expandAll() }
    if !request.focus.isEmpty {
      var path = bmapp.StringList()
      for name in request.focus { path.push_back(std.string(name)) }
      let changed = document.session.focus(path)
      if !changed.refused.empty() {
        FileHandle.standardError.write("snapshot: \(String(changed.refused))\n".data(using: .utf8)!)
        return 1
      }
      document.postChange()
      viewport.fitAll()
    }
    if let tab = request.inspector {
      controller.model.refresh()
      controller.model.inspectorTab = tab
    }
    if let q = request.palette {
      CommandPalette.keepWhenInactive = true
      CommandPalette.show(over: window, query: q)
    }
    if let k = request.editStep {
      controller.model.sidebarTab = .steps
      controller.model.editingStep = k
    }
    if controller.model.sidebarTab == .parts {
      prepareParts(query: controller.model.partsQuery, dark: window.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua)
    }
    if let part = request.placement {
      let id = part.hasSuffix(".dat") ? part : part + ".dat"
      guard let match = bmapp.libraryParts(bmapp.Session.ldrawDirectory(), std.string(id), std.string(), 1)
        .map(LibraryPart.init).first(where: { $0.id == id }) else { return 1 }
      let p = NSPoint(x: viewportView.bounds.width * request.placementAt.x,
                      y: viewportView.bounds.height * (1 - request.placementAt.y))
      viewportView.placement.begin(match, colour: 4, turns: 0, mirrored: false, step: nil, at: p)
    }

    if (request.playTo != nil || request.animation != nil) && document.session.pieceCount() > 0 {
      viewport.requestPlan()
      let deadline = Date().addingTimeInterval(300)
      while viewport.planState() == .Planning, Date() < deadline {
        _ = viewport.draw(nil)
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
      }
      if let time = request.playTo { viewport.seek(time) }
      controller.model.animation.update()
    }
    viewportView.presentation.update()

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
    var parts = [controller.sidebarView, controller.inspectorView, controller.timelineView].compactMap { $0 }
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

  /// Give the snapshot the same loaded parts a person sees after the preview requests finish.
  @MainActor private static func prepareParts(query: String, dark: Bool) {
    var ready = false
    let load = Task {
      let library = await PartsCatalog.shared.library()
      _ = await PartsCatalog.shared.categories(in: library.directory)
      let parts = query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? library.common :
        await PartsCatalog.shared.search(in: library.directory, query: query, category: nil, limit: 12)
      for part in parts where !Task.isCancelled {
        _ = await PartPreviewCache.shared.image(for: .init(part: part.id, color: 71, dark: dark))
      }
      ready = true
    }
    let deadline = Date().addingTimeInterval(20)
    while !ready, Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
    load.cancel()
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
    // Popovers are windows of their own: each is captured and drawn where it sits over the window.
    var extras: [(CGImage, NSRect)] = []
    for other in NSApp.windows where other !== window && other.isVisible && other.frame.intersects(window.frame) {
      if let cg = windowImage(.null, 1 << 3, UInt32(other.windowNumber), (1 << 0) | (1 << 3))?.takeRetainedValue() {
        extras.append((cg, other.frame))
      }
    }
    let frame = window.frame
    window.orderOut(nil)
    guard let cg = image, cg.width > 0 else { return nil }
    // Only a real picture counts: a capture the system refused comes back blank.
    let rep = NSBitmapImageRep(cgImage: cg)
    rep.size = size
    if isBlank(rep) { return nil }
    if !extras.isEmpty, let context = NSGraphicsContext(bitmapImageRep: rep) {
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current = context
      for (image, at) in extras {
        context.cgContext.draw(image, in: CGRect(x: at.minX - frame.minX, y: at.minY - frame.minY, width: at.width, height: at.height))
      }
      NSGraphicsContext.restoreGraphicsState()
    }
    return rep
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
