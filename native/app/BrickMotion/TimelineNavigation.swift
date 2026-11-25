import AppKit
import BMApp
import SwiftUI

private let timelineCoordinates = "TimelineViewport"

struct TimelineScale {
  let width: CGFloat
  let duration: Double

  func x(_ time: Double) -> CGFloat { width * time / max(duration, 0.001) }
  func time(_ x: CGFloat) -> Double { duration * min(1, max(0, x / max(1, width))) }

  var interval: Double { bmapp.tickInterval(duration, Double(width)) }
}

/// The scroll plumbing of a timeline track area; the zoom and offset maths are bmapp's TimelineView.
@MainActor @Observable final class TimelineNavigation {
  static let inset: CGFloat = 12
  static let maximumZoom = bmapp.TimelineView.maximumZoom()
  let trailingInset: CGFloat
  private var view: bmapp.TimelineView
  private(set) var scrollRequest = 0
  var scrubbing = false
  var followsPlayhead = true
  private var awaitingZoom = false

  init(trailingInset: CGFloat = TimelineNavigation.inset) {
    self.trailingInset = trailingInset
    var view = bmapp.TimelineView()
    view.leadInset = Double(Self.inset)
    view.trailInset = Double(trailingInset)
    self.view = view
  }

  var zoom: Double { view.zoom }
  var viewportWidth: CGFloat { CGFloat(view.viewportWidth) }
  var offset: CGFloat { CGFloat(view.offset) }
  var logicalWidth: CGFloat { CGFloat(view.logicalWidth()) }
  var contentWidth: CGFloat { CGFloat(view.contentWidth()) }
  var maximumOffset: CGFloat { CGFloat(view.maximumOffset()) }
  var visibleStart: Double { view.visibleStart() }
  var visibleEnd: Double { view.visibleEnd() }

  func measure(viewport: CGFloat, content: CGFloat, offset actual: CGFloat) {
    if abs(viewportWidth - viewport) > 0.5 { view.viewportWidth = Double(max(1, viewport)) }
    if awaitingZoom {
      guard abs(contentWidth - content) < 2 else { return }
      awaitingZoom = false
      scrollRequest &+= 1
    } else if abs(offset - actual) > 0.25 {
      view.offset = Double(min(maximumOffset, max(0, actual)))
    }
  }

  func magnify(_ factor: Double, around screenX: CGFloat) {
    if view.magnify(factor, Double(screenX)) { awaitingZoom = true }
  }

  func zoomBy(_ factor: Double, playhead: Double, duration: Double) {
    if view.zoomBy(factor, playhead, duration) { awaitingZoom = true }
  }

  func fit() {
    let zoomed = zoom > 1
    guard view.fit() else { return }
    if zoomed { awaitingZoom = true } else { scrollRequest &+= 1 }
  }

  func reveal(_ time: Double, duration: Double, centred: Bool = false, playing: Bool = false) {
    guard !scrubbing, !playing || followsPlayhead else { return }
    if view.reveal(time, duration, centred) { scrollRequest &+= 1 }
  }

  func time(at screenX: CGFloat, duration: Double) -> Double { view.timeAt(Double(screenX), duration) }

  func panAtEdge(_ x: CGFloat) -> Bool {
    guard view.panAtEdge(Double(x)) else { return false }
    scrollRequest &+= 1
    return true
  }
}

struct TimelineTrackArea<Tracks: View>: View {
  let navigation: TimelineNavigation
  let duration: Double
  let playhead: () -> Double
  let playing: Bool
  @ViewBuilder let tracks: (TimelineScale) -> Tracks
  @State private var position = ScrollPosition(edge: .leading)
  @State private var measured = false

  var body: some View {
    ScrollView(.horizontal) {
      tracks(TimelineScale(width: navigation.logicalWidth, duration: duration))
        .padding(.leading, TimelineNavigation.inset)
        .padding(.trailing, navigation.trailingInset)
    }
    .frame(maxWidth: .infinity)
    .coordinateSpace(name: timelineCoordinates)
    .scrollPosition($position)
    .scrollBounceBehavior(.basedOnSize)
    .onScrollGeometryChange(for: Metrics.self) { geometry in
      Metrics(viewport: geometry.containerSize.width, content: geometry.contentSize.width,
              offset: geometry.contentOffset.x + geometry.contentInsets.leading)
    } action: { _, metrics in
      let offset = measured ? metrics.offset : navigation.offset
      navigation.measure(viewport: metrics.viewport, content: metrics.content, offset: offset)
      if !measured {
        measured = true
        if offset > 0 { position.scrollTo(x: offset) }
      }
    }
    .onChange(of: navigation.scrollRequest) {
      var immediate = Transaction()
      immediate.disablesAnimations = true
      withTransaction(immediate) { position.scrollTo(x: navigation.offset) }
    }
    .background {
      TimelineZoomInput { factor, x in navigation.magnify(factor, around: x) }
    }
    .background { TimelineFollowPlayhead(navigation: navigation, duration: duration, time: playhead, playing: playing) }
    .accessibilityIdentifier("TimelineTracks")
  }

  private struct Metrics: Equatable {
    let viewport, content, offset: CGFloat
  }
}

private struct TimelineFollowPlayhead: View {
  let navigation: TimelineNavigation
  let duration: Double
  let time: () -> Double
  let playing: Bool

  var body: some View {
    Color.clear.allowsHitTesting(false).accessibilityHidden(true)
      .onChange(of: time()) { _, newTime in navigation.reveal(newTime, duration: duration, playing: playing) }
  }
}

struct TimelineRuler<Face: View>: View {
  let navigation: TimelineNavigation
  let duration, playhead, increment: Double
  let title, value: String
  let seek: (Double) -> Void
  @ViewBuilder let face: () -> Face
  @State private var pointer: CGFloat?

  var body: some View {
    face()
      .contentShape(Rectangle())
      .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .named(timelineCoordinates))
        .onChanged { event in
          navigation.scrubbing = true
          pointer = event.location.x
          seek(navigation.time(at: event.location.x, duration: duration))
        }
        .onEnded { _ in reset() })
      .task(id: pointer != nil) {
        while pointer != nil, !Task.isCancelled {
          try? await Task.sleep(for: .milliseconds(16))
          guard let current = self.pointer, !Task.isCancelled else { break }
          if navigation.panAtEdge(current) { seek(navigation.time(at: current, duration: duration)) }
        }
      }
      .onDisappear(perform: reset)
      .accessibilityElement()
      .accessibilityLabel(title)
      .accessibilityValue(value)
      .accessibilityAdjustableAction { change in
        switch change {
        case .increment: seek(min(duration, playhead + increment))
        case .decrement: seek(max(0, playhead - increment))
        @unknown default: break
        }
      }
  }

  private func reset() {
    pointer = nil
    navigation.scrubbing = false
  }
}

struct TimelineTickFace: View {
  let navigation: TimelineNavigation
  let scale: TimelineScale
  let interval: Double
  let label: (Double) -> Text

  var body: some View {
    let leading = navigation.offset - TimelineNavigation.inset
    let trailing = leading + navigation.viewportWidth
    return Canvas { context, size in
      let spacing = max(1, scale.x(interval))
      let first = max(0, Int(floor((leading - 76) / spacing)))
      let last = min(Int(scale.duration / interval), Int(ceil(trailing / spacing)))
      let end = size.width - 0.5
      var ticks = Path()
      func mark(_ x: CGFloat) {
        ticks.move(to: CGPoint(x: x, y: size.height - 6))
        ticks.addLine(to: CGPoint(x: x, y: size.height))
      }
      if first <= last {
        for index in first...last {
          let time = Double(index) * interval
          let x = scale.x(time)
          guard x < end - 1 else { continue }
          mark(x)
          if x + 76 < end {
            context.draw(label(time), at: CGPoint(x: x + 4, y: size.height - 13), anchor: .leading)
          }
        }
      }
      if end >= leading && end - 76 <= trailing {
        mark(end)
        context.draw(label(scale.duration), at: CGPoint(x: end - 4, y: size.height - 13), anchor: .trailing)
      }
      context.stroke(ticks, with: .color(.secondary.opacity(0.5)), lineWidth: 0.5)
    }
  }
}

struct TimelineOverview: View {
  let navigation: TimelineNavigation
  let workspace: AnimationWorkspace
  let duration, increment: Double
  let seek: (Double) -> Void
  @GestureState private var dragging = false
  private var playhead: Double { workspace.time }

  var body: some View {
    HStack(spacing: 11) {
      Label("Overview", systemImage: "timeline.selection")
        .font(.caption.weight(.medium)).foregroundStyle(.secondary)
        .labelStyle(.titleAndIcon)
      GeometryReader { geometry in
        let width = max(1, geometry.size.width - 10)
        let now = width * min(1, max(0, playhead / max(duration, 0.01)))
        let start = width * navigation.visibleStart
        let end = width * navigation.visibleEnd
        ZStack(alignment: .leading) {
          Capsule().fill(.primary.opacity(0.08)).frame(height: 5)
          if navigation.zoom > 1 {
            Capsule().fill(Color.accentColor.opacity(0.22))
              .overlay(Capsule().strokeBorder(Color.accentColor.opacity(0.3)))
              .frame(width: max(4, end - start), height: 9)
              .offset(x: start)
          }
          Circle().fill(Color.accentColor)
            .overlay(Circle().strokeBorder(.background.opacity(0.85)))
            .frame(width: dragging ? 12 : 10, height: dragging ? 12 : 10)
            .offset(x: now - (dragging ? 6 : 5))
        }
        .frame(width: width, height: geometry.size.height)
        .padding(.horizontal, 5)
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 0)
          .updating($dragging) { _, state, _ in state = true }
          .onChanged { event in seek(duration * min(1, max(0, (event.location.x - 5) / width))) })
      }
      Text(timecode(duration))
        .font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
        .fixedSize()
    }
    .frame(height: 30)
    .padding(.horizontal, 13)
    .background(.primary.opacity(0.025))
    .help("Drag the playhead to scrub the entire timeline")
    .accessibilityElement()
    .accessibilityLabel("Timeline overview playhead")
    .accessibilityValue(timecode(playhead))
    .accessibilityAdjustableAction { change in
      switch change {
      case .increment: seek(min(duration, playhead + increment))
      case .decrement: seek(max(0, playhead - increment))
      @unknown default: break
      }
    }
  }
}

struct TimelineResizeGrip: View {
  let height: () -> CGFloat
  let resize: (CGFloat) -> Void
  let save: () -> Void
  let reset: () -> Void
  var body: some View {
    TimelineResizeInput(height: height, resize: resize, save: save, reset: reset)
      .frame(height: 13)
      .background(.bar)
      .help("Drag to resize the timeline. Double-click to reset.")
      .accessibilityElement()
      .accessibilityLabel("Timeline panel height")
      .accessibilityAdjustableAction { change in
        switch change {
        case .increment: resize(height() + 44)
        case .decrement: resize(height() - 44)
        @unknown default: return
        }
        save()
      }
      .accessibilityAction(named: Text("Reset Timeline Height"), reset)
  }
}

private struct TimelineResizeInput: NSViewRepresentable {
  let height: () -> CGFloat
  let resize: (CGFloat) -> Void
  let save: () -> Void
  let reset: () -> Void

  func makeNSView(context: Context) -> Grip { Grip() }
  func updateNSView(_ view: Grip, context: Context) {
    view.height = height
    view.resize = resize
    view.save = save
    view.reset = reset
  }

  final class Grip: NSView {
    var height: (() -> CGFloat)?
    var resize: ((CGFloat) -> Void)?
    var save: (() -> Void)?
    var reset: (() -> Void)?
    private var start: (y: CGFloat, height: CGFloat)?

    override func resetCursorRects() { addCursorRect(bounds, cursor: .resizeUpDown) }

    override func draw(_ dirtyRect: NSRect) {
      let rect = NSRect(x: bounds.midX - 19, y: bounds.midY - 1.5, width: 38, height: 3)
      (start == nil ? NSColor.secondaryLabelColor : NSColor.controlAccentColor).withAlphaComponent(0.5).setFill()
      NSBezierPath(roundedRect: rect, xRadius: 1.5, yRadius: 1.5).fill()
    }

    override func mouseDown(with event: NSEvent) {
      if event.clickCount == 2 { reset?(); return }
      if let height { start = (event.locationInWindow.y, height()); needsDisplay = true }
    }

    override func mouseDragged(with event: NSEvent) {
      if let start { resize?(start.height + event.locationInWindow.y - start.y) }
    }

    override func mouseUp(with event: NSEvent) {
      guard start != nil else { return }
      start = nil
      needsDisplay = true
      save?()
    }
  }
}

/// AppKit routes the gesture to the scroll area even when a clip or ruler handles mouse input.
private struct TimelineZoomInput: NSViewRepresentable {
  let zoom: (Double, CGFloat) -> Void

  func makeNSView(context: Context) -> HitArea { HitArea() }
  func updateNSView(_ view: HitArea, context: Context) { view.zoom = zoom }
  static func dismantleNSView(_ view: HitArea, coordinator: ()) { view.detachMonitor() }

  final class HitArea: NSView {
    var zoom: ((Double, CGFloat) -> Void)?
    private var monitor: Any?

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      detachMonitor()
      guard window != nil else { return }
      monitor = NSEvent.addLocalMonitorForEvents(matching: [.magnify, .scrollWheel]) { [weak self] event in
        guard let self, event.window === window else { return event }
        let point = convert(event.locationInWindow, from: nil)
        guard bounds.contains(point) else { return event }
        let delta: Double
        if event.type == .magnify { delta = event.magnification }
        else if event.modifierFlags.contains(.option) { delta = Double(event.scrollingDeltaY) * 0.012 }
        else { return event }
        zoom?(exp(min(1, max(-1, delta))), point.x)
        return nil
      }
    }

    func detachMonitor() {
      if let monitor { NSEvent.removeMonitor(monitor); self.monitor = nil }
    }
  }
}
