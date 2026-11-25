import AppKit
import CoreText
import SwiftUI

@MainActor final class PartLaneLayout {
  struct Clip: Identifiable {
    var id: UInt32 { flight.id }
    var code: String { label.code }
    let flight: AnimationWorkspace.Flight
    let label: Label
    let rect: CGRect
    let timeX: CGFloat
    let durationWidth: CGFloat
    var x: CGFloat { rect.minX }
  }

  final class Label {
    let code: String
    let width: CGFloat
    let line: CTLine

    init(_ code: String, font: NSFont) {
      self.code = code
      let attributes: [NSAttributedString.Key: Any] = [
        .font: font, NSAttributedString.Key(kCTForegroundColorFromContextAttributeName as String): true
      ]
      let full = CTLineCreateWithAttributedString(NSAttributedString(string: code, attributes: attributes))
      let advance = CTLineGetTypographicBounds(full, nil, nil, nil)
      width = min(PartLaneLayout.maximumLabelWidth, max(52, ceil(advance) + 23))
      if advance > width - 22 {
        let ellipsis = CTLineCreateWithAttributedString(NSAttributedString(string: "…", attributes: attributes))
        line = CTLineCreateTruncatedLine(full, width - 22, .middle, ellipsis) ?? ellipsis
      } else {
        line = full
      }
    }
  }

  static let rowHeight: CGFloat = 20
  static let clipHeight: CGFloat = 17
  static let inset: CGFloat = 4
  static let font = NSFont.monospacedSystemFont(ofSize: 10, weight: .semibold)
  nonisolated private static let maximumLabelWidth: CGFloat = 90
  private static let labels: NSCache<NSString, Label> = {
    let cache = NSCache<NSString, Label>()
    cache.countLimit = 4096
    return cache
  }()
  private(set) var rows: [[Clip]] = []
  var height: CGFloat { max(1, CGFloat(rows.count)) * Self.rowHeight + 2 * Self.inset }

  init(_ flights: [AnimationWorkspace.Flight] = [], scale: TimelineScale = .init(width: 0, duration: 0)) {
    guard scale.width >= 100, scale.duration > 0 else { return }
    var labels: [String: Label] = [:]
    var geometry: [(flight: AnimationWorkspace.Flight, label: Label, x: CGFloat, timeX: CGFloat, width: CGFloat, duration: CGFloat)] = []
    geometry.reserveCapacity(flights.count)
    var previousX = -CGFloat.infinity
    var needsSort = false
    for flight in flights {
      let timeX = scale.x(flight.start)
      let duration = max(0, scale.x(flight.end - flight.start))
      let label: Label
      if let previous = labels[flight.part] {
        label = previous
      } else {
        label = Self.label(for: flight.part)
        labels[flight.part] = label
      }
      let width = max(label.width + (flight.pinned ? 10 : 0), duration - 1)
      let x = min(timeX, max(0, scale.width - width))
      if x < previousX { needsSort = true }
      previousX = x
      geometry.append((flight, label, x, timeX, width, duration))
    }
    // Short final clips can overhang their duration. Keep their labels inside the axis
    // and retain a separate mark at the actual flight start when a label has to shift.
    if needsSort {
      geometry.sort { $0.x == $1.x ? $0.timeX < $1.timeX : $0.x < $1.x }
    }
    var slots = RowEnds()
    for entry in geometry {
      let row = slots.place(at: entry.x + 0.0001, until: entry.x + entry.width + 1)
      if row == rows.count { rows.append([]) }
      let rect = CGRect(x: entry.x, y: Self.inset + CGFloat(row) * Self.rowHeight, width: entry.width, height: Self.clipHeight)
      rows[row].append(Clip(flight: entry.flight, label: entry.label, rect: rect, timeX: entry.timeX, durationWidth: entry.duration))
    }
  }

  private static func label(for part: String) -> Label {
    let code = part.lowercased().hasSuffix(".dat") ? String(part.dropLast(4)) : part
    let key = code as NSString
    if let cached = labels.object(forKey: key) { return cached }
    let label = Label(code, font: font)
    labels.setObject(label, forKey: key)
    return label
  }

  /// Leaves hold each row's end. Parents hold the earliest end below them, so
  /// finding the first available row stays logarithmic even at Fit on dense builds.
  private struct RowEnds {
    private var ends: [CGFloat] = [.infinity, .infinity]
    private var capacity = 1
    private var count = 0

    mutating func place(at x: CGFloat, until end: CGFloat) -> Int {
      var leaf = 1
      if ends[1] <= x {
        while leaf < capacity {
          leaf *= 2
          if ends[leaf] > x { leaf += 1 }
        }
      } else {
        if count == capacity { grow() }
        leaf = capacity + count
        count += 1
      }
      let row = leaf - capacity
      ends[leaf] = end
      while leaf > 1 {
        leaf /= 2
        ends[leaf] = min(ends[leaf * 2], ends[leaf * 2 + 1])
      }
      return row
    }

    private mutating func grow() {
      let previous = ends
      capacity *= 2
      ends = Array(repeating: .infinity, count: capacity * 2)
      for row in 0..<count { ends[capacity + row] = previous[count + row] }
      for node in (1..<capacity).reversed() { ends[node] = min(ends[node * 2], ends[node * 2 + 1]) }
    }
  }

  func forEachVisible(in rect: CGRect, _ visit: (Clip) -> Void) {
    guard !rect.isNull, !rows.isEmpty else { return }
    let lowerRow = max(0, Int(floor((rect.minY - Self.inset) / Self.rowHeight)))
    let upperRow = min(rows.count, Int(ceil((rect.maxY - Self.inset) / Self.rowHeight)))
    guard lowerRow < upperRow else { return }
    for row in rows[lowerRow..<upperRow] {
      var low = 0, high = row.count
      while low < high {
        let middle = (low + high) / 2
        if row[middle].rect.maxX < rect.minX { low = middle + 1 } else { high = middle }
      }
      for index in low..<row.count {
        let clip = row[index]
        if clip.rect.minX > rect.maxX { break }
        if clip.rect.intersects(rect) { visit(clip) }
      }
    }
  }

  func clip(at point: CGPoint) -> Clip? {
    let rowIndex = Int(floor((point.y - Self.inset) / Self.rowHeight))
    guard rows.indices.contains(rowIndex) else { return nil }
    let row = rows[rowIndex]
    var low = 0, high = row.count
    while low < high {
      let middle = (low + high) / 2
      if row[middle].rect.maxX < point.x { low = middle + 1 } else { high = middle }
    }
    return row.indices.contains(low) && row[low].rect.contains(point) ? row[low] : nil
  }
}

struct TimelinePartLane: NSViewRepresentable {
  let layout: PartLaneLayout
  let model: DocumentModel
  let selection: Set<UInt32>
  let isEnabled: Bool
  let catalogInsertion: TimelineArrivalTarget?
  let select: (AnimationWorkspace.Flight, Bool) -> Void
  let reveal: (AnimationWorkspace.Flight) -> Void
  let target: ([UInt32], CGFloat) -> TimelineArrivalTarget?
  let panAtEdge: (CGFloat) -> Bool
  let drop: ([UInt32], TimelineArrivalTarget, Bool) -> Void
  let editFlight: (AnimationWorkspace.Flight) -> Void

  func makeNSView(context: Context) -> PartLaneView { PartLaneView() }

  func updateNSView(_ view: PartLaneView, context: Context) {
    view.configure(layout: layout, model: model, selection: selection)
    view.isEnabled = isEnabled
    view.setCatalogInsertion(catalogInsertion)
    view.select = select
    view.reveal = reveal
    view.target = target
    view.panAtEdge = panAtEdge
    view.drop = drop
    view.editFlight = editFlight
  }
}

final class PartLaneView: NSView {
  private struct CapsuleKey: Hashable {
    let code: String
    let colour: Int32
    let width: Int
    let selected, flagged: Bool
  }

  private struct Swatch {
    let fill: CGColor
    let duration: CGColor?
  }

  private var layout = PartLaneLayout()
  private weak var model: DocumentModel?
  private var selection = Set<UInt32>()
  private var colours: [Int32: Swatch] = [:]
  private var capsules: [CapsuleKey: CGImage] = [:]
  private var rasterScale: CGFloat = 0
  private var rasterAccent: CGColor?
  private var hover: PartLaneLayout.Clip?
  private var dragStart: (clip: PartLaneLayout.Clip, x: CGFloat, ids: [UInt32])?
  private var dragPointer: CGPoint?
  private var dragPan: Task<Void, Never>?
  private var dropTarget: TimelineArrivalTarget?
  private var catalogInsertion: TimelineArrivalTarget?
  private var forceDrop = false
  private let pinIcon = NSImage(systemSymbolName: "pin.fill", accessibilityDescription: nil)
  private var tracking: NSTrackingArea?
  private var motion: NSPopover?
  private var accessibilityViewport: (local: NSRect, screen: NSRect)?
  private var accessibilityItems: [UInt32: PartElement] = [:]
  private var visibleAccessibilityItems: [PartElement] = []
  var select: ((AnimationWorkspace.Flight, Bool) -> Void)?
  var reveal: ((AnimationWorkspace.Flight) -> Void)?
  var target: (([UInt32], CGFloat) -> TimelineArrivalTarget?)?
  var panAtEdge: ((CGFloat) -> Bool)?
  var drop: (([UInt32], TimelineArrivalTarget, Bool) -> Void)?
  var editFlight: ((AnimationWorkspace.Flight) -> Void)?
  var isEnabled = true {
    didSet {
      guard oldValue != isEnabled else { return }
      accessibilityViewport = nil
      if !isEnabled { cancelDrag() }
    }
  }
  override var isFlipped: Bool { true }

  override init(frame: NSRect) {
    super.init(frame: frame)
    setAccessibilityElement(true)
    setAccessibilityRole(.group)
    setAccessibilityLabel("Parts timeline")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("The Parts lane is created by TimelinePartLane") }

  func configure(layout: PartLaneLayout, model: DocumentModel, selection: Set<UInt32>) {
    if self.model !== model {
      self.model = model
      colours.removeAll()
      capsules.removeAll()
      accessibilityViewport = nil
    }
    let changedLayout = self.layout !== layout
    if changedLayout {
      self.layout = layout
      hover = nil
      cancelDrag()
      toolTip = nil
    }
    if changedLayout || self.selection != selection {
      self.selection = selection
      accessibilityViewport = nil
      needsDisplay = true
    }
  }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    capsules.removeAll()
    needsDisplay = true
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let tracking { removeTrackingArea(tracking) }
    let area = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .inVisibleRect, .activeInKeyWindow],
                             owner: self)
    addTrackingArea(area)
    tracking = area
  }

  override func mouseMoved(with event: NSEvent) {
    updateHover(layout.clip(at: convert(event.locationInWindow, from: nil)))
  }

  override func mouseExited(with event: NSEvent) { updateHover(nil) }

  override func mouseDown(with event: NSEvent) {
    cancelDrag()
    let point = convert(event.locationInWindow, from: nil)
    guard isEnabled, let clip = layout.clip(at: point) else { super.mouseDown(with: event); return }
    let ids = selection.contains(clip.id) ? selection.sorted() : [clip.id]
    dragStart = (clip, point.x, ids)
  }

  override func mouseDragged(with event: NSEvent) {
    guard let start = dragStart else { return }
    let point = convert(event.locationInWindow, from: nil)
    guard abs(point.x - start.x) >= 5 || dragPointer != nil else { return }
    dragPointer = event.locationInWindow
    updateHover(nil)
    setDropTarget(target?(start.ids, point.x), force: event.modifierFlags.contains(.option))
    if dragPan == nil {
      dragPan = Task { @MainActor [weak self] in
        while !Task.isCancelled {
          try? await Task.sleep(for: .milliseconds(16))
          guard !Task.isCancelled, self?.continueDragPan() == true else { return }
        }
      }
    }
  }

  override func mouseUp(with event: NSEvent) {
    guard isEnabled, let start = dragStart else { cancelDrag(); super.mouseUp(with: event); return }
    let point = convert(event.locationInWindow, from: nil)
    let wasDragging = dragPointer != nil
    let destination = wasDragging ? target?(start.ids, point.x) : nil
    cancelDrag()
    if let destination {
      drop?(start.ids, destination, event.modifierFlags.contains(.option))
    } else if !wasDragging, layout.clip(at: point)?.id == start.clip.id {
      if event.clickCount == 2 {
        editFlight?(start.clip.flight)
      } else if start.clip.flight.pinned, point.x >= start.clip.rect.maxX - 12, let model,
                model.document.session.isLocalPiece(start.clip.id) {
        model.context.perform { $0.setArrivalPinned(ViewportView.list([start.clip.id]), false) }
      } else {
        select?(start.clip.flight, event.modifierFlags.contains(.command) || event.modifierFlags.contains(.shift))
      }
    }
  }

  private func continueDragPan() -> Bool {
    guard window != nil, let start = dragStart, let pointer = dragPointer else {
      cancelDrag()
      return false
    }
    let point = convert(pointer, from: nil)
    let viewport = visibleRect
    if !viewport.isEmpty {
      _ = panAtEdge?(point.x - viewport.minX)
      setDropTarget(target?(start.ids, point.x), force: NSEvent.modifierFlags.contains(.option))
    }
    return true
  }

  private func cancelDrag() {
    dragPan?.cancel()
    dragPan = nil
    dragPointer = nil
    dragStart = nil
    setDropTarget(nil)
  }

  private func setDropTarget(_ next: TimelineArrivalTarget?, force: Bool = false) {
    guard dropTarget != next || forceDrop != force else { return }
    if let dropTarget { setNeedsDisplay(markerRect(at: dropTarget.x)) }
    dropTarget = next
    forceDrop = force
    if let next { setNeedsDisplay(markerRect(at: next.x)) }
  }

  func setCatalogInsertion(_ insertion: TimelineArrivalTarget?) {
    guard catalogInsertion != insertion else { return }
    if let catalogInsertion { setNeedsDisplay(markerRect(at: catalogInsertion.x)) }
    catalogInsertion = insertion
    if let insertion { setNeedsDisplay(markerRect(at: insertion.x)) }
  }

  private func markerRect(at x: CGFloat) -> CGRect {
    let visible = visibleRect
    return CGRect(x: x - 164, y: visible.minY, width: 328, height: visible.height)
  }

  override func menu(for event: NSEvent) -> NSMenu? {
    guard let clip = layout.clip(at: convert(event.locationInWindow, from: nil)) else { return nil }
    return makeMenu(for: clip)
  }

  private func makeMenu(for clip: PartLaneLayout.Clip) -> NSMenu? {
    guard isEnabled, let model else { return nil }
    let ids = selection.contains(clip.id) ? selection.sorted() : [clip.id]
    return TimelinePartMenu.make(flight: clip.flight, model: model, selection: ids,
                                 reveal: { [weak self] in self?.reveal?(clip.flight) },
                                 editMotion: { [weak self] in self?.showMotion(for: clip, pieces: ids) },
                                 editFlight: { [weak self] in self?.editFlight?(clip.flight) })
  }

  private func showMotion(for clip: PartLaneLayout.Clip, pieces: [UInt32]) {
    guard let model else { return }
    let popover = NSPopover()
    popover.behavior = .transient
    let description = String(model.document.session.partAt(clip.id).description)
    let editor = MotionEditor(model: model, scope: .Parts, step: clip.flight.step, pieces: pieces,
                              title: pieces.count == 1 ? displayName(description) : "\(pieces.count) Parts", close: { [weak popover] in popover?.close() })
    popover.contentViewController = NSHostingController(rootView: editor)
    motion?.close()
    motion = popover
    popover.show(relativeTo: clip.rect, of: self, preferredEdge: .minY)
  }

  private func updateHover(_ clip: PartLaneLayout.Clip?) {
    if hover?.id == clip?.id { return }
    if let hover { setNeedsDisplay(hover.rect.insetBy(dx: -1, dy: -1)) }
    hover = clip
    if let clip {
      setNeedsDisplay(clip.rect.insetBy(dx: -1, dy: -1))
      toolTip = "\(clip.flight.part) · \(colourName(clip)) · Step \(clip.flight.step + 1) · \(timecode(clip.flight.start))"
    } else { toolTip = nil }
  }

  private func colourName(_ clip: PartLaneLayout.Clip) -> String {
    model?.colors[clip.flight.colour].map { String($0.name) } ?? "Colour \(clip.flight.colour)"
  }

  private func swatch(for code: Int32) -> Swatch {
    if let colour = colours[code] { return colour }
    let rgb = model?.colors[code]?.rgb ?? 0x777777
    let colour = NSColor(srgbRed: CGFloat(rgb >> 16 & 255) / 255, green: CGFloat(rgb >> 8 & 255) / 255,
                         blue: CGFloat(rgb & 255) / 255, alpha: 1).cgColor
    let swatch = Swatch(fill: colour, duration: colour.copy(alpha: 0.67))
    colours[code] = swatch
    return swatch
  }

  private func drawCapsule(_ clip: PartLaneLayout.Clip, in rect: CGRect, fill: CGColor, border: CGColor,
                           dot: CGColor, dotBorder: CGColor, text: CGColor, context: CGContext) {
    let shape = CGPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), cornerWidth: 4.5, cornerHeight: 4.5, transform: nil)
    context.setFillColor(fill)
    context.setStrokeColor(border)
    context.setLineWidth(1)
    context.addPath(shape)
    context.drawPath(using: .fillStroke)
    let swatch = CGRect(x: rect.minX + 5.5, y: rect.midY - 4, width: 8, height: 8)
    context.setFillColor(dot)
    context.fillEllipse(in: swatch)
    context.setStrokeColor(dotBorder)
    context.setLineWidth(0.5)
    context.strokeEllipse(in: swatch)
    context.setFillColor(text)
    context.textPosition = CGPoint(x: rect.minX + 18, y: rect.midY + 3.25)
    CTLineDraw(clip.label.line, context)
  }

  private func raster(_ key: CapsuleKey, clip: PartLaneLayout.Clip, fill: CGColor, border: CGColor,
                      dot: CGColor, dotBorder: CGColor, text: CGColor) -> CGImage? {
    if let cached = capsules[key] { return cached }
    guard capsules.count < 320, let space = CGColorSpace(name: CGColorSpace.sRGB),
          let bitmap = CGContext(data: nil, width: Int(clip.rect.width * rasterScale),
                                 height: Int(clip.rect.height * rasterScale), bitsPerComponent: 8,
                                 bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    bitmap.translateBy(x: 0, y: clip.rect.height * rasterScale)
    bitmap.scaleBy(x: rasterScale, y: -rasterScale)
    bitmap.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
    drawCapsule(clip, in: CGRect(origin: .zero, size: clip.rect.size), fill: fill, border: border,
                dot: dot, dotBorder: dotBorder, text: text, context: bitmap)
    guard let image = bitmap.makeImage() else { return nil }
    capsules[key] = image
    return image
  }

  override func draw(_ dirtyRect: NSRect) {
    let visible = visibleRect.intersection(dirtyRect)
    guard !visible.isEmpty, let context = NSGraphicsContext.current?.cgContext else { return }
    let text = NSColor.labelColor.cgColor
    let accent = NSColor.controlAccentColor.cgColor
    let flag = NSColor.systemOrange.cgColor
    let background = NSColor.labelColor.withAlphaComponent(0.022).cgColor
    let fill = NSColor.labelColor.withAlphaComponent(0.062).cgColor
    let hoveredFill = NSColor.labelColor.withAlphaComponent(0.15).cgColor
    let selectedFill = NSColor.controlAccentColor.withAlphaComponent(0.23).cgColor
    let border = NSColor.labelColor.withAlphaComponent(0.15).cgColor
    let hoveredBorder = NSColor.labelColor.withAlphaComponent(0.28).cgColor
    let dotBorder = NSColor.labelColor.withAlphaComponent(0.24).cgColor
    let scale = window?.backingScaleFactor ?? 2
    if rasterScale != scale || rasterAccent != accent {
      capsules.removeAll()
      rasterScale = scale
      rasterAccent = accent
    }
    context.setFillColor(background)
    context.fill(visible)
    context.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
    layout.forEachVisible(in: visible) { clip in
      let rect = clip.rect
      let active = selection.contains(clip.id), pointed = hover?.id == clip.id
      let swatch = swatch(for: clip.flight.colour)
      let flagged = !clip.flight.flag.isEmpty
      let capsuleFill = active ? selectedFill : pointed ? hoveredFill : fill
      let capsuleBorder = active ? accent : flagged ? flag : pointed ? hoveredBorder : border
      let key = CapsuleKey(code: clip.code, colour: clip.flight.colour, width: Int(rect.width), selected: active, flagged: flagged)
      let canRaster = !pointed && rect.width <= 104 && CGFloat(key.width) == rect.width
      if canRaster, let image = raster(key, clip: clip, fill: capsuleFill, border: capsuleBorder,
                                      dot: swatch.fill, dotBorder: dotBorder, text: text) {
        context.saveGState()
        context.translateBy(x: (rect.minX * scale).rounded() / scale, y: rect.maxY)
        context.scaleBy(x: 1, y: -1)
        context.draw(image, in: CGRect(origin: .zero, size: rect.size))
        context.restoreGState()
      } else {
        drawCapsule(clip, in: rect, fill: capsuleFill, border: capsuleBorder,
                    dot: swatch.fill, dotBorder: dotBorder, text: text, context: context)
      }
      if clip.durationWidth > 2, let travel = swatch.duration {
        context.setFillColor(travel)
        let begin = max(rect.minX + 3, clip.timeX)
        context.fill(CGRect(x: begin, y: rect.maxY - 2, width: min(rect.maxX - begin, clip.durationWidth - 2), height: 1))
      }
      if clip.flight.pinned {
        pinIcon?.draw(in: CGRect(x: rect.maxX - 11, y: rect.midY - 4, width: 8, height: 8),
                      from: .zero, operation: .sourceOver, fraction: 0.85, respectFlipped: true, hints: nil)
      }
    }
    if let dropTarget = dropTarget ?? catalogInsertion {
      let viewport = visibleRect
      context.setFillColor(accent)
      context.fill(CGRect(x: dropTarget.x - 1, y: viewport.minY, width: 2, height: viewport.height))
      let title = "Step \(dropTarget.step + 1) · \(dropTarget.before + 1)\(forceDrop ? " · Pin" : "")"
      let attributes: [NSAttributedString.Key: Any] = [.font: PartLaneLayout.font, .foregroundColor: NSColor.labelColor]
      let width = (title as NSString).size(withAttributes: attributes).width + 12
      let x = max(viewport.minX + 2, min(dropTarget.x + 5, viewport.maxX - width - 2))
      let y = viewport.minY + 3
      let label = NSBezierPath(roundedRect: CGRect(x: x, y: y, width: width, height: 19), xRadius: 4, yRadius: 4)
      NSColor.windowBackgroundColor.setFill()
      label.fill()
      NSColor.controlAccentColor.setStroke()
      label.stroke()
      (title as NSString).draw(at: CGPoint(x: x + 6, y: y + 3), withAttributes: attributes)
    }
  }

  override func accessibilityChildren() -> [Any]? {
    guard let window else { return [] }
    let local = visibleRect
    let screen = window.convertToScreen(convert(local, to: nil))
    if let cached = accessibilityViewport, cached.local == local && cached.screen == screen {
      return visibleAccessibilityItems
    }
    var children: [PartElement] = []
    var items: [UInt32: PartElement] = [:]
    layout.forEachVisible(in: local) { clip in
      let element = accessibilityItems[clip.id] ?? PartElement()
      element.setAccessibilityParent(self)
      element.setAccessibilityRole(.button)
      element.setAccessibilityLabel("Part \(clip.code), \(colourName(clip)), step \(clip.flight.step + 1)")
      element.setAccessibilityValue("Arrives at \(timecode(clip.flight.end))\(clip.flight.pinned ? ", pinned" : "")")
      element.setAccessibilitySelected(selection.contains(clip.id))
      element.setAccessibilityFrame(window.convertToScreen(convert(clip.rect, to: nil)))
      element.setAccessibilityEnabled(isEnabled)
      element.press = isEnabled ? { [weak self] in self?.select?(clip.flight, false) } : nil
      element.showMenu = isEnabled ? { [weak self] in
        guard let self, let menu = makeMenu(for: clip) else { return }
        menu.popUp(positioning: nil, at: NSPoint(x: clip.rect.minX, y: clip.rect.maxY), in: self)
      } : nil
      element.setAccessibilityCustomActions(isEnabled ? [NSAccessibilityCustomAction(name: "Show Part Menu", handler: { [weak element] in
        element?.accessibilityPerformShowMenu() ?? false
      })] : nil)
      items[clip.id] = element
      children.append(element)
    }
    accessibilityViewport = (local, screen)
    accessibilityItems = items
    visibleAccessibilityItems = children
    return children
  }

  private final class PartElement: NSAccessibilityElement {
    var press: (() -> Void)?
    var showMenu: (() -> Void)?
    override func accessibilityPerformPress() -> Bool { press?(); return press != nil }
    override func accessibilityPerformShowMenu() -> Bool { showMenu?(); return showMenu != nil }
  }
}
