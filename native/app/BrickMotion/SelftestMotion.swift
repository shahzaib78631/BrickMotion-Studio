// --selftest-motion <file>: drives the viewport's motion handles with real mouse and key events,
// as a person would: a flight path's points (drag, add, delete), a waiting part's floor spot and
// the Build's Camera lane (menus, press, drag) and the Camera inspector's lens sliders.
// Prints the first failure.
import AppKit
import BMApp
import SwiftUI

@MainActor func selftestMotion(_ path: String) -> Int32 {
  NSApplication.shared.setActivationPolicy(.prohibited)
  NSApp.mainMenu = MainMenu.make()
  let document = Document()
  do { try document.load(URL(fileURLWithPath: path)) } catch {
    print("selftest-motion: \(error.localizedDescription)")
    return 1
  }
  document.makeWindowControllers()
  guard let controller = document.windowControllers.first as? WindowController,
        let window = controller.window else { return 1 }
  window.layoutIfNeeded()
  let view = controller.viewportController.viewportView
  guard view.viewport.ok() else { print("selftest-motion: no Metal device"); return 1 }
  let session = document.session
  func fail(_ why: String) -> Int32 { print("selftest-motion: \(why)"); return 1 }
  func turn() { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
  func draw() {
    turn()  // each gesture its own pass, as events are: undo groups by event
    _ = view.viewport.draw(nil)
    view.updateEditorOverlays()
  }
  func screen(_ p: bmapp.Vec3) -> NSPoint {
    let projected = bmapp.projectPoint(view.viewport.camera(), bmapp.Vec2(x: view.bounds.width, y: view.bounds.height), p)
    return NSPoint(x: projected.x, y: view.bounds.height - projected.y)
  }
  func mouse(_ type: NSEvent.EventType, _ point: NSPoint, clicks: Int = 1, flags: NSEvent.ModifierFlags = []) -> NSEvent {
    NSEvent.mouseEvent(with: type, location: view.convert(point, to: nil), modifierFlags: flags,
                       timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                       context: nil, eventNumber: 0, clickCount: clicks, pressure: 1)!
  }
  func key(_ code: UInt16, _ text: String) {
    let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
                                 timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                 context: nil, characters: text, charactersIgnoringModifiers: text,
                                 isARepeat: false, keyCode: code)!
    view.keyDown(with: event)
  }
  func value(_ piece: UInt32, _ channel: bmapp.KeyChannel, _ frame: Int32) -> Double {
    session.keyValue(piece, channel, Double(frame))
  }

  // A loose piece's flight open as keys, edited in the keyframe timeline.
  guard let piece = session.snapshot().selected.first(where: { $0.submodelPath.empty() })?.piece ??
          (0..<session.pieceCount()).lazy.map({ UInt32($0) }).first(where: { session.isLocalPiece($0) }) else {
    return fail("no loose piece")
  }
  let scene = session.keyScene()
  let first = scene.first + 10, last = scene.first + 40
  var keys = bmapp.KeyList()
  for (channel, a, b) in [(bmapp.KeyChannel.PositionX, 3.0, 0.0), (.PositionY, 4.0, 0.0), (.PositionZ, 0.0, 0.0)] {
    keys.push_back(bmapp.Keyframe(channel: channel, frame: first, value: a, interpolation: .Linear))
    keys.push_back(bmapp.Keyframe(channel: channel, frame: last, value: b, interpolation: .Linear))
  }
  guard document.perform({ session.setBakedKeys(piece, keys) }).refused.empty() else { return fail("could not open the flight as keys") }
  controller.setAnimateMode(true, plan: false)
  guard let animation = view.animation else { return fail("no animation workspace") }
  animation.tab = .timeline
  view.select([piece], .Replace)
  animation.seekScene(0)
  draw()
  guard animation.isKeyEditing else { return fail("the keyframe timeline is not editing keys") }

  // 1. The path is drawn: a point at each key frame, the line between.
  let flight = view.viewport.flightPath(piece)
  guard !flight.empty(), flight.keys.count == 2, flight.line.count == Int(last - first) + 1 else {
    return fail("the path has \(flight.keys.count) points and \(flight.line.count) samples")
  }

  // 2. A double-click on the line adds a point there, one "Add Path Point" step.
  let middle = flight.line[flight.line.count / 2]
  var depth = session.undoDepth()
  let onLine = screen(middle.at)
  view.mouseDown(with: mouse(.leftMouseDown, onLine, clicks: 1))
  view.mouseUp(with: mouse(.leftMouseUp, onLine, clicks: 1))
  view.mouseDown(with: mouse(.leftMouseDown, onLine, clicks: 2))
  view.mouseUp(with: mouse(.leftMouseUp, onLine, clicks: 2))
  draw()
  guard session.undoDepth() == depth + 1, String(session.undoName()) == "Add Path Point" else {
    return fail("double-clicking the path made \(session.undoDepth() - depth) steps, last \(session.undoName())")
  }
  let added = view.viewport.flightPath(piece)
  guard added.keys.count == 3, let point = added.keys.first(where: { $0.frame != first && $0.frame != last }),
        abs(Int(point.frame) - Int(middle.frame)) <= 1 else { return fail("the new point is not where the path was clicked") }
  guard abs(value(piece, .PositionY, point.frame) - 4 * Double(last - point.frame) / Double(last - first)) < 1e-6 else {
    return fail("adding a point changed the path")
  }
  guard Array(session.selection()) == [piece] else { return fail("adding a point changed the selection") }

  // 3. Dragging the point moves it in the view's plane: one "Move Path Point" step, the ends kept.
  depth = session.undoDepth()
  let before = (value(piece, .PositionX, point.frame), value(piece, .PositionY, point.frame), value(piece, .PositionZ, point.frame))
  let grab = screen(point.at)
  view.mouseDown(with: mouse(.leftMouseDown, grab))
  for step in 1...6 {
    view.mouseDragged(with: mouse(.leftMouseDragged, NSPoint(x: grab.x + CGFloat(step) * 6, y: grab.y + CGFloat(step) * 4)))
  }
  view.mouseUp(with: mouse(.leftMouseUp, NSPoint(x: grab.x + 36, y: grab.y + 24)))
  draw()
  guard session.undoDepth() == depth + 1, String(session.undoName()) == "Move Path Point" else {
    return fail("dragging a point made \(session.undoDepth() - depth) steps, last \(session.undoName())")
  }
  let after = (value(piece, .PositionX, point.frame), value(piece, .PositionY, point.frame), value(piece, .PositionZ, point.frame))
  let moved = hypot(hypot(after.0 - before.0, after.1 - before.1), after.2 - before.2)
  guard moved > 0.2 else { return fail("dragging a point moved it \(moved) studs") }
  guard abs(value(piece, .PositionX, first) - 3) < 1e-6, abs(value(piece, .PositionY, last)) < 1e-6 else {
    return fail("dragging a point moved the rest of the path")
  }
  let dropped = screen(view.viewport.flightPath(piece).keys.first(where: { $0.frame == point.frame })!.at)
  guard hypot(dropped.x - grab.x - 36, dropped.y - grab.y - 24) < 3 else {
    return fail("the point landed at \(dropped), not under the pointer")
  }
  let scenePlayhead = scene.first + Int32((animation.time * Double(scene.fps)).rounded())
  guard scenePlayhead == point.frame else { return fail("pressing a point did not seek to it") }

  // 4. Its menu deletes it; so does Delete once it is clicked. Never the first or the last.
  guard let menu = view.menu(for: mouse(.rightMouseDown, dropped)), menu.item(withTitle: "Delete Path Point") != nil else {
    return fail("the point's menu has no Delete Path Point")
  }
  guard let lineMenu = view.menu(for: mouse(.rightMouseDown, screen(view.viewport.flightPath(piece).line[Int(point.frame - first) / 2].at))),
        lineMenu.item(withTitle: "Add Path Point") != nil else { return fail("the path's menu has no Add Path Point") }
  depth = session.undoDepth()
  view.mouseDown(with: mouse(.leftMouseDown, dropped))
  view.mouseUp(with: mouse(.leftMouseUp, dropped))
  key(51, "\u{7f}")
  draw()
  guard session.undoDepth() == depth + 1, String(session.undoName()) == "Delete Path Point",
        view.viewport.flightPath(piece).keys.count == 2, session.pieceCount() > piece else {
    return fail("Delete on a clicked point did not delete just the point (\(session.undoName()))")
  }
  depth = session.undoDepth()
  let start = screen(view.viewport.flightPath(piece).keys.first(where: { $0.frame == first })!.at)
  view.mouseDown(with: mouse(.leftMouseDown, start))
  view.mouseUp(with: mouse(.leftMouseUp, start))
  key(51, "\u{7f}")
  draw()
  guard session.undoDepth() == depth, view.viewport.flightPath(piece).keys.count == 2 else {
    return fail("Delete removed the path's first point")
  }
  document.undoManager?.undo()
  draw()
  guard view.viewport.flightPath(piece).keys.count == 3 else { return fail("undo did not bring the point back") }

  // 5. Out of the keyframe timeline the path is not there to hit.
  animation.tab = .build
  draw()
  depth = session.undoDepth()
  view.mouseDown(with: mouse(.leftMouseDown, dropped, clicks: 2))
  view.mouseUp(with: mouse(.leftMouseUp, dropped, clicks: 2))
  if String(session.undoName()).contains("Path Point") && session.undoDepth() != depth {
    return fail("the path took a click outside the keyframe timeline")
  }

  // 6. In the Build preview a part waiting on the floor is dragged to a new spot: one "Move
  //    Waiting Part" step, nothing replanned; Esc puts a drag back.
  animation.plan()
  let planDeadline = Date().addingTimeInterval(30)
  while !(animation.ready && view.viewport.plannedVersion() == session.version()), Date() < planDeadline {
    draw()
    animation.update()
  }
  guard animation.ready else { return fail("the Build did not plan") }
  /// A spot on screen showing a part that waits on the floor now, and that part.
  func waitingSpot() -> (NSPoint, UInt32)? {
    for row in stride(from: 0.05, to: 0.95, by: 0.025) {
      for column in stride(from: 0.05, to: 0.95, by: 0.0125) {
        let x = view.bounds.width * column, y = view.bounds.height * row
        let hit = view.viewport.pick(x, y)
        if hit != UInt32.max, view.viewport.canMoveWaitingPart(hit) { return (NSPoint(x: x, y: view.bounds.height - y), hit) }
      }
    }
    return nil
  }
  var spot: (NSPoint, UInt32)?
  for share in stride(from: 0.02, to: 0.6, by: 0.04) where spot == nil {
    animation.seek(animation.duration * share)
    draw()
    spot = waitingSpot()
  }
  guard let (grab2, waiting) = spot else { return fail("no part waits on the floor anywhere in the Build") }
  depth = session.undoDepth()
  view.mouseDown(with: mouse(.leftMouseDown, grab2))
  for step in 1...8 { view.mouseDragged(with: mouse(.leftMouseDragged, NSPoint(x: grab2.x + CGFloat(step) * 8, y: grab2.y))) }
  view.mouseUp(with: mouse(.leftMouseUp, NSPoint(x: grab2.x + 64, y: grab2.y)))
  draw()
  guard session.undoDepth() == depth + 1, String(session.undoName()) == "Move Waiting Part" else {
    return fail("dragging a waiting part made \(session.undoDepth() - depth) steps, last \(session.undoName())")
  }
  let shift = session.waitingShift(waiting)
  guard hypot(shift.x, shift.z) > 0.5, abs(shift.y) < 1e-9 else { return fail("the waiting part moved \(shift.x), \(shift.y), \(shift.z) studs") }
  guard view.viewport.planState() == .Ready, view.viewport.plannedVersion() == session.version() else {
    return fail("moving a waiting part replanned the Build")
  }
  guard Array(session.selection()) == [waiting] else { return fail("the dragged part is not selected") }
  // Esc mid-drag: nothing kept
  depth = session.undoDepth()
  guard let (grab3, _) = waitingSpot() else { return fail("the moved part no longer waits") }
  view.mouseDown(with: mouse(.leftMouseDown, grab3))
  for step in 1...4 { view.mouseDragged(with: mouse(.leftMouseDragged, NSPoint(x: grab3.x, y: grab3.y + CGFloat(step) * 10))) }
  key(53, "\u{1b}")
  view.mouseUp(with: mouse(.leftMouseUp, NSPoint(x: grab3.x, y: grab3.y + 40)))
  draw()
  guard session.undoDepth() == depth else { return fail("Esc kept a waiting part's drag") }
  document.undoManager?.undo()
  draw()
  guard hypot(session.waitingShift(waiting).x, session.waitingShift(waiting).z) < 1e-9 else {
    return fail("undo did not put the waiting part back")
  }

  // 7. The Build's Camera lane, as it is drawn: its menus add a key from the view, give a move a
  //    preset and delete a key; a key is pressed to show it and dragged along the lane to move it.
  let model: DocumentModel = controller.model
  let duration = animation.buildDuration
  let laneWidth: CGFloat = 640
  let laneScale = TimelineScale(width: laneWidth, duration: duration)
  let lane = NSHostingView(rootView: CameraTrackLane(model: model, workspace: animation, clock: .Build, scale: laneScale))
  let laneWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: laneWidth, height: CameraTrackLane.height),
                            styleMask: [.borderless], backing: .buffered, defer: false)
  laneWindow.contentView = lane
  laneWindow.orderFrontRegardless()  // SwiftUI takes a gesture's events only in a window on screen
  laneWindow.layoutIfNeeded()
  func laneEvent(_ type: NSEvent.EventType, _ x: CGFloat) -> NSEvent {
    NSEvent.mouseEvent(with: type, location: NSPoint(x: x, y: CameraTrackLane.height / 2), modifierFlags: [],
                       timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: laneWindow.windowNumber,
                       context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
  }
  func laneMenu(at x: CGFloat) -> NSMenu? {
    turn()
    lane.layoutSubtreeIfNeeded()
    guard let hit = lane.hitTest(NSPoint(x: x, y: CameraTrackLane.height / 2)) else { return nil }
    return hit.menu(for: laneEvent(.rightMouseDown, x)) ?? lane.menu(for: laneEvent(.rightMouseDown, x))
  }
  func run(_ menu: NSMenu?, _ title: String) -> Bool {
    func find(_ menu: NSMenu) -> (NSMenu, Int)? {
      for (i, item) in menu.items.enumerated() {
        if item.title == title { return (menu, i) }
        if let sub = item.submenu, let found = find(sub) { return found }
      }
      return nil
    }
    guard let menu, let (owner, index) = find(menu), owner.items[index].isEnabled else { return false }
    owner.performActionForItem(at: index)
    turn()
    return true
  }
  guard model.cameraKeys(.Build).isEmpty else { return fail("the Build already has camera keys") }
  for share in [0.2, 0.7] {
    animation.seek(duration * share)
    view.viewport.orbit(40, 0)
    draw()
    depth = session.undoDepth()
    guard run(laneMenu(at: laneScale.x(animation.time) + 30), "Add Camera Key from View") else {
      return fail("the Camera lane's menu has no Add Camera Key from View")
    }
    guard session.undoDepth() == depth + 1 else { return fail("adding a camera key made \(session.undoDepth() - depth) steps") }
  }
  turn()
  var cameraKeys = model.cameraKeys(.Build)
  guard cameraKeys.count == 2, animation.director else { return fail("the lane has \(cameraKeys.count) keys, Follow Camera \(animation.director)") }

  // the move between them takes a preset from its own menu
  let moveX = (laneScale.x(cameraKeys[0].seconds) + laneScale.x(cameraKeys[1].seconds)) / 2
  guard let preset = CameraPresets.all.map({ String($0.label) }).first(where: { $0 != CameraPresets.label(String(cameraKeys[0].preset)) }),
        run(laneMenu(at: moveX), preset) else { return fail("the move's menu has no preset to choose") }
  cameraKeys = model.cameraKeys(.Build)
  guard CameraPresets.label(String(cameraKeys[0].preset)) == preset else { return fail("choosing \(preset) left \(cameraKeys[0].preset)") }

  // a press on a key shows it in the inspector and seeks there
  let firstX = laneScale.x(cameraKeys[0].seconds)
  laneWindow.sendEvent(laneEvent(.leftMouseDown, firstX))
  laneWindow.sendEvent(laneEvent(.leftMouseUp, firstX))
  turn()
  guard model.cameraSelection == CameraSelection(clock: .Build, item: .key(String(cameraKeys[0].id))),
        abs(animation.time - cameraKeys[0].seconds) < 1 / animation.fps + 1e-6 else {
    return fail("pressing a key did not show it (\(String(describing: model.cameraSelection)), playhead \(animation.time))")
  }
  // dragged along the lane: one step, the key later by the distance dragged
  depth = session.undoDepth()
  laneWindow.sendEvent(laneEvent(.leftMouseDown, firstX))
  for step in 1...8 { laneWindow.sendEvent(laneEvent(.leftMouseDragged, firstX + CGFloat(step) * 5)) }
  laneWindow.sendEvent(laneEvent(.leftMouseUp, firstX + 40))
  turn()
  let draggedTo = model.cameraKeys(.Build).first { String($0.id) == String(cameraKeys[0].id) }?.seconds ?? -1
  guard session.undoDepth() == depth + 1, abs(draggedTo - (cameraKeys[0].seconds + laneScale.time(40))) < 2 / animation.fps else {
    return fail("dragging a key made \(session.undoDepth() - depth) steps and moved it to \(draggedTo) s")
  }
  // its menu deletes it
  guard run(laneMenu(at: laneScale.x(draggedTo)), "Delete Key"), model.cameraKeys(.Build).count == 1,
        model.cameraSelection == nil else { return fail("the key's menu did not delete it") }
  guard run(laneMenu(at: 4), "Clear Camera Track"), model.cameraKeys(.Build).isEmpty else {
    return fail("the lane's menu did not clear the track")
  }
  laneWindow.close()

  // 8. The Camera inspector's sliders, stepped as the keyboard and VoiceOver step them: each change
  //    to a key's Dutch Roll or Background Blur is one undo step, written to the key.
  animation.seek(duration * 0.5)
  draw()
  CameraLaneMenu.addKey(model: model, workspace: animation, clock: .Build)
  turn()
  guard let rolled = model.cameraKeys(.Build).first, model.cameraSelection?.keyId == String(rolled.id) else {
    return fail("adding a key did not show it in the inspector")
  }
  let inspector = NSHostingView(rootView: Form {
    CameraSelectionInspector(model: model, workspace: animation, selection: model.cameraSelection!)
  }.formStyle(.grouped))
  let inspectorWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 900), styleMask: [.borderless],
                                 backing: .buffered, defer: false)
  inspectorWindow.contentView = inspector
  inspectorWindow.orderFrontRegardless()
  defer { inspectorWindow.close() }
  /// The inspector's sliders (AppKit's, under SwiftUI's, which reads them 0 to 1), in the order
  /// shown. With focus on what the key looks at, its last two are Dutch Roll and Background Blur.
  func sliders(in view: NSView) -> [NSSlider] {
    (view as? NSSlider).map { [$0] } ?? view.subviews.flatMap { sliders(in: $0) }
  }
  guard rolled.focusTarget else { return fail("a new key does not focus on what it looks at") }
  for (label, read, range) in [("Dutch Roll", { (k: bmapp.CameraTrackKey) in k.roll }, -45.0...45.0), ("Background Blur", { $0.blur }, 0.0...1.0)] {
    turn()
    inspector.layoutSubtreeIfNeeded()
    let all = sliders(in: inspector)
    guard all.count >= 2 else { return fail("the inspector shows \(all.count) sliders") }
    let slider = all[all.count - (label == "Dutch Roll" ? 2 : 1)]
    let key = model.cameraKeys(.Build).first { String($0.id) == String(rolled.id) }!
    let shown = range.lowerBound + slider.doubleValue * (range.upperBound - range.lowerBound)
    guard abs(shown - read(key)) < 1e-6 else { return fail("the \(label) slider shows \(shown), the key \(read(key))") }
    depth = session.undoDepth()
    let before = model.cameraKeys(.Build).first { String($0.id) == String(rolled.id) }.map(read) ?? 0
    for _ in 0..<2 {
      _ = slider.accessibilityPerformIncrement()
      turn()
    }
    let now = model.cameraKeys(.Build).first { String($0.id) == String(rolled.id) }.map(read) ?? 0
    guard now > before, session.undoDepth() == depth + 2 else {
      return fail("two steps of \(label) made \(session.undoDepth() - depth) undo steps, \(before) to \(now)")
    }
  }

  print("selftest-motion: ok")
  return 0
}
