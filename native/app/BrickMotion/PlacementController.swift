import AppKit
import BMApp
import Observation

/// The gesture owns a read-only preview until the user asks to commit its latest request.
@MainActor @Observable final class PlacementController {
  @ObservationIgnored private unowned let view: ViewportView
  @ObservationIgnored var history = PartsHistory.shared
  private(set) var part: LibraryPart?
  private(set) var state = bmapp.PlacementState.Inactive
  private(set) var reason = ""
  private(set) var gripCount = 0
  private(set) var snap = true
  private(set) var awaitingCommit = false
  private(set) var isMoving = false
  private(set) var checksCollisions = true

  @ObservationIgnored private var input = bmapp.PlacementInput()
  @ObservationIgnored private var at = NSPoint.zero
  @ObservationIgnored private var request: UInt64 = 0
  @ObservationIgnored private var generation: UInt64 = 0
  @ObservationIgnored private var version: UInt64 = 0
  @ObservationIgnored private var step: Int32 = -1
  @ObservationIgnored private var beforeItem: Int32 = -1
  @ObservationIgnored private var autoGrip = 0

  init(view: ViewportView) { self.view = view }

  var active: Bool { part != nil }
  var canPlace: Bool { state == .Free || state == .Snapped || state == .Reference }

  func begin(_ part: LibraryPart, colour: Int32, turns: Int, mirrored: Bool, step: Int?,
             beforeItem: Int? = nil,
             reference: Bool = false, at initialPoint: NSPoint? = nil, anchor: UInt32 = .max, grabbedAt: NSPoint = .zero,
             selection: [UInt32] = [], option: Bool = false) {
    guard let document = view.document, view.bounds.width > 0, view.bounds.height > 0 else { return }
    cancel()
    view.viewport.showRest()
    self.part = part
    input.part = std.string(part.id)
    input.color = colour
    input.turns = Int32(turns)
    input.mirrored = mirrored
    input.snap = !option
    input.reference = reference
    input.collision = view.collisionChecks
    checksCollisions = input.collision
    input.anchor = anchor
    input.grab = bmapp.Vec2(x: grabbedAt.x, y: view.bounds.height - grabbedAt.y)
    input.selection = ViewportView.list(selection)
    isMoving = anchor != .max
    snap = !option
    generation = document.session.generation()
    version = document.session.version()
    self.step = step.flatMap(Int32.init(exactly:)) ?? -1
    self.beforeItem = beforeItem.flatMap(Int32.init(exactly:)) ?? -1
    state = .Preparing
    let mouse = view.window.map { view.convert($0.mouseLocationOutsideOfEventStream, from: nil) }
    at = initialPoint ?? mouse.flatMap { view.bounds.contains($0) ? $0 : nil } ??
      NSPoint(x: view.bounds.midX, y: view.bounds.midY)
    view.window?.makeFirstResponder(view)
    update()
  }

  func beginMove(piece: UInt32, selection: [UInt32], from start: NSPoint, to point: NSPoint, option: Bool) {
    guard let session = view.document?.session else { return }
    let part = session.partAt(piece)
    guard !part.name.empty() else { return }
    begin(LibraryPart(part), colour: 71, turns: 0, mirrored: false, step: nil, at: point,
          anchor: piece, grabbedAt: start, selection: selection, option: option)
  }

  func move(to point: NSPoint, option: Bool) {
    guard active, !awaitingCommit else { return }
    guard point != at || option == input.snap else { return }
    at = point
    input.snap = !option
    snap = input.snap
    update()
  }

  func nudge(x: Double, y: Double) {
    let p = NSPoint(x: min(max(at.x + x, 0), view.bounds.width), y: min(max(at.y + y, 0), view.bounds.height))
    move(to: p, option: !input.snap)
  }

  func moveWithCamera() {
    if active && !awaitingCommit { update() }
  }

  func chooseColour(_ colour: Int32) {
    guard active, !isMoving, !awaitingCommit, input.color != colour else { return }
    input.color = colour
    update()
  }

  func optionChanged(_ held: Bool) {
    if active && input.snap == held { move(to: at, option: held) }
  }

  func collisionChanged(_ enabled: Bool) {
    guard active, !awaitingCommit, input.collision != enabled else { return }
    input.collision = enabled
    checksCollisions = enabled
    update()
  }

  func turn() {
    guard active, !awaitingCommit else { return }
    input.turns = (input.turns + 1) % 4
    update()
  }

  func cycleGrip(back: Bool = false) {
    guard active, gripCount > 1, !awaitingCommit else { return }
    let from = input.grip < 0 ? autoGrip : Int(input.grip)
    input.grip = Int32((from + gripCount + (back ? -1 : 1)) % gripCount)
    update()
  }

  func accept() {
    guard active, request > 0 else { return }
    awaitingCommit = true
    receive(view.viewport.placementPreview())
  }

  func receive(_ preview: bmapp.PlacementPreview) {
    guard active, preview.request > 0 else { return }
    state = preview.state
    reason = String(preview.reason)
    gripCount = Int(preview.gripCount)
    if preview.state == .Snapped { autoGrip = Int(preview.grip) }
    guard awaitingCommit, preview.request == request, let part, let document = view.document else { return }
    awaitingCommit = false
    guard canPlace else {
      if !reason.isEmpty {
        NSAccessibility.post(element: view, notification: .announcementRequested,
                             userInfo: [.announcement: reason, .priority: NSAccessibilityPriorityLevel.high.rawValue])
      }
      return
    }
    let colour = input.color
    let moving = isMoving
    let anchor = input.anchor
    let selection = input.selection
    let result = document.perform {
      if moving {
        return document.session.placeMoved(selection, anchor, preview.pose, preview.generation, preview.version)
      }
      return document.session.placePartBefore(std.string(part.id), colour, preview.pose, step, beforeItem,
                                               preview.generation, preview.version)
    }
    if result.refused.empty() {
      if !moving { history.record(part) }
      cancel()
    } else {
      state = .Unavailable
      reason = String(result.refused)
    }
  }

  func modelChanged() {
    guard active, let session = view.document?.session else { return }
    if session.generation() != generation || session.version() != version { cancel() }
  }

  func cancel() {
    guard active else { return }
    part = nil
    state = .Inactive
    reason = ""
    gripCount = 0
    autoGrip = 0
    snap = true
    awaitingCommit = false
    isMoving = false
    input = bmapp.PlacementInput()
    request = 0
    view.viewport.clearPlacementPreview()
    view.changed()
  }

  private func update() {
    request = view.viewport.previewPart(input, bmapp.Vec2(x: at.x, y: view.bounds.height - at.y))
    if request == 0 {
      state = .Unavailable
      reason = isMoving ? "Open the submodel to move this piece independently." : "The part preview is unavailable."
    }
    view.changed()
  }
}
