// --bench-open <file>: from the process's start to the first frame of the model drawn (the GPU
// finished with it), as JSON. --bench-edit <file>: 200 moves and 200 recolours, each timed from
// the command to its frame finished on the GPU, as JSON. Both draw into the viewport's own
// picture at the size a default window's viewport has, with nothing shown.
import AppKit
import BMApp
import Darwin
import os

private let benchWidth: Int32 = 1920, benchHeight: Int32 = 1700  // a 1440x900 window's viewport at 2x

/// When this process started, by the kernel's clock of it.
private func processStart() -> Date {
  var info = kinfo_proc()
  var size = MemoryLayout<kinfo_proc>.stride
  var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
  guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return Date() }
  let t = info.kp_proc.p_un.__p_starttime
  return Date(timeIntervalSince1970: Double(t.tv_sec) + Double(t.tv_usec) / 1e6)
}

private func p95(_ ms: [Double]) -> Double {
  let s = ms.sorted()
  return s.isEmpty ? 0 : s[min(s.count - 1, Int((Double(s.count) * 0.95).rounded(.up)) - 1)]
}

private func json(_ pairs: [(String, Any)]) -> String {
  "{" + pairs.map { k, v in
    let value: String
    if let d = v as? Double { value = String(format: "%.3f", d) } else if let s = v as? String { value = "\"\(s)\"" } else { value = "\(v)" }
    return "\"\(k)\":\(value)"
  }.joined(separator: ",") + "}"
}

private func openForBench(_ path: String) -> (bmapp.Session, bmapp.Viewport)? {
  let session = bmapp.Session.create()!
  let r = session.open(std.string(path))
  guard r.ok, let viewport = bmapp.Viewport.create(session), viewport.ok() else {
    FileHandle.standardError.write("bench: \(String(r.error))\n".data(using: .utf8)!)
    return nil
  }
  viewport.resize(benchWidth, benchHeight, 2)
  return (session, viewport)
}

/// Measures presented drawables in a live editor with the Build timeline open and zoomed.
@MainActor func benchPlayback(_ path: String) -> Int32 {
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  app.finishLaunching()
  let document = Document()
  do {
    try document.load(URL(fileURLWithPath: path))
  } catch {
    FileHandle.standardError.write(Data("Playback benchmark: \(error.localizedDescription)\n".utf8))
    return 1
  }
  document.makeWindowControllers()
  guard let controller = document.windowControllers.first as? WindowController, let window = controller.window else { return 1 }
  let workspace = controller.model.animation
  let view = controller.viewportController.viewportView
  window.setContentSize(NSSize(width: 1280, height: 780))
  window.center()
  window.orderFrontRegardless()
  defer { window.orderOut(nil) }
  controller.setAnimateMode(true, plan: false)
  workspace.plan()
  let deadline = CACurrentMediaTime() + 30
  while workspace.busy, CACurrentMediaTime() < deadline {
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
  }
  guard workspace.ready, workspace.buildEnd - workspace.buildStart > 6 else { return 1 }
  let navigation = workspace.buildNavigation
  workspace.seek(workspace.buildStart + (workspace.buildEnd - workspace.buildStart) * 0.4)
  navigation.zoomBy(12, playhead: workspace.time, duration: workspace.buildDuration)
  RunLoop.main.run(until: Date().addingTimeInterval(0.25))
  // Put the playhead near the visible right edge, so playback triggers the usual follow scroll.
  let secondsPerPoint = workspace.buildDuration / navigation.logicalWidth
  let seek = (navigation.offset + navigation.viewportWidth * 0.92 - TimelineNavigation.inset) * secondsPerPoint
  workspace.seek(seek)
  RunLoop.main.run(until: Date().addingTimeInterval(0.2))
  let startOffset = navigation.offset
  let presented = OSAllocatedUnfairLock(initialState: [CFTimeInterval]())
  view.presentedFrame = { time in
    if time > 0 { presented.withLock { $0.append(time) } }
  }
  let started = CACurrentMediaTime()
  workspace.togglePlayback()
  RunLoop.main.run(until: Date().addingTimeInterval(5))
  view.presentedFrame = nil
  if workspace.state.playing { workspace.togglePlayback() }
  let times = presented.withLock { $0.filter { $0 >= started + 0.4 }.sorted() }
  let intervals = zip(times, times.dropFirst()).map { ($1 - $0) * 1000 }
  guard intervals.count > 10 else {
    FileHandle.standardError.write(Data("Playback benchmark: fewer than eleven presented frame intervals.\n".utf8))
    return 1
  }
  let size = "\(Int(view.bounds.width * view.scale))x\(Int(view.bounds.height * view.scale))"
  print(json([("file", (path as NSString).lastPathComponent), ("viewport", size), ("playbackP95Ms", p95(intervals)),
              ("intervals", intervals.count), ("maxMs", intervals.max() ?? 0), ("followDistancePoints", navigation.offset - startOffset)]))
  return 0
}

@MainActor func benchOpen(_ path: String) -> Int32 {
  let start = processStart()
  guard let (session, viewport) = openForBench(path) else { return 1 }
  _ = viewport.draw(nil)
  let ms = Date().timeIntervalSince(start) * 1000
  print(json([("file", (path as NSString).lastPathComponent), ("pieces", session.pieceCount()), ("openToFirstFrameMs", ms)]))
  return 0
}

@MainActor func benchEdit(_ path: String) -> Int32 {
  guard let (session, viewport) = openForBench(path) else { return 1 }
  var settle = 0
  while viewport.draw(nil) && settle < 600 { settle += 1 }  // the maps drawn over frames, done
  let count = UInt32(session.pieceCount())
  func timed(_ edit: (UInt32, Int) -> Void) -> (frame: [Double], command: [Double]) {
    var frame: [Double] = [], command: [Double] = []
    for i in 0..<200 {
      let piece = UInt32((i / 2 * 37) % Int(count))
      let t0 = CACurrentMediaTime()
      edit(piece, i)
      let t1 = CACurrentMediaTime()
      _ = viewport.draw(nil)
      let t2 = CACurrentMediaTime()
      command.append((t1 - t0) * 1000)
      frame.append((t2 - t0) * 1000)
    }
    return (frame, command)
  }
  let moves = timed { piece, i in
    var p = bmapp.PieceList()
    p.push_back(piece)
    _ = session.move(p, bmapp.Vec3(x: i % 2 == 0 ? 20 : -20, y: 0, z: 0), false)
  }
  let colours = timed { piece, i in
    var p = bmapp.PieceList()
    p.push_back(piece)
    _ = session.recolor(p, Int32(i % 2 == 0 ? 14 : 4))
  }
  var removed: [Double] = []
  for i in 0..<24 {
    let piece = UInt32(i * 37 % Int(count))
    var one = bmapp.PieceList()
    one.push_back(piece)
    let start = CACurrentMediaTime()
    _ = session.remove(one)
    _ = viewport.draw(nil)
    removed.append((CACurrentMediaTime() - start) * 1000)
    _ = session.undo()
    _ = viewport.draw(nil)
  }
  print(json([("file", (path as NSString).lastPathComponent), ("pieces", session.pieceCount()), ("size", "\(benchWidth)x\(benchHeight)"),
              ("moveP95Ms", p95(moves.frame)), ("moveCommandP95Ms", p95(moves.command)),
              ("recolorP95Ms", p95(colours.frame)), ("recolorCommandP95Ms", p95(colours.command)),
              ("deleteP95Ms", p95(removed))]))
  return 0
}

@MainActor func benchOrbit(_ path: String) -> Int32 {
  guard let (session, viewport) = openForBench(path) else { return 1 }
  viewport.resize(1920, 1200, 2)
  viewport.fitAll()
  var samples: [Double] = []
  for i in 0..<150 {
    let start = CACurrentMediaTime()
    viewport.orbit(2, i % 12 == 0 ? -1 : 0.1)
    _ = viewport.draw(nil)
    if i >= 30 { samples.append((CACurrentMediaTime() - start) * 1000) }
  }
  print(json([("file", (path as NSString).lastPathComponent), ("pieces", session.pieceCount()),
              ("size", "1920x1200"), ("orbitP95Ms", p95(samples)), ("samples", samples.count)]))
  return 0
}

@MainActor func benchPartLane() -> Int32 {
  NSApplication.shared.setActivationPolicy(.prohibited)
  let document = Document()
  guard document.session.newBlank().ok else { return 1 }
  let model = DocumentModel(document: document)
  let names = ["3001.dat", "98138.dat", "3069b.dat", "3024.dat", "4032a.dat"]
  let colours: [Int32] = [4, 7, 14, 1, 2]
  let flights = (0..<12_000).map { i in
    let time = Double(i) / 8
    return AnimationWorkspace.Flight(id: UInt32(i), step: i / 10, depth: 0, colour: colours[i % 5],
                                     start: time, end: time + 0.5, part: names[i % 5],
                                     flag: i.isMultiple(of: 60) ? "blocked" : "", blocker: "")
  }
  let viewBounds = CGRect(x: 0, y: 0, width: 1440, height: 410)
  let scale = TimelineScale(width: 1800, duration: 1500)
  let view = PartLaneView(frame: viewBounds)
  var layout = PartLaneLayout()
  var creation: [Double] = []
  for _ in 0..<30 {
    let start = CACurrentMediaTime()
    layout = PartLaneLayout(flights, scale: scale)
    creation.append((CACurrentMediaTime() - start) * 1000)
  }
  var visible = 0
  layout.forEachVisible(in: viewBounds) { _ in visible += 1 }
  view.configure(layout: layout, model: model, selection: [])
  let image = NSImage(size: viewBounds.size)
  image.lockFocusFlipped(true)
  var draws: [Double] = []
  for draw in 0..<120 {
    let start = CACurrentMediaTime()
    view.draw(viewBounds)
    if draw >= 30 { draws.append((CACurrentMediaTime() - start) * 1000) }
  }
  image.unlockFocus()
  print(json([("syntheticParts", flights.count), ("visible", visible), ("layoutP95Ms", p95(creation)),
              ("drawP95Ms", p95(draws)), ("drawSamples", draws.count)]))
  return 0
}

@MainActor func benchTimeline(_ path: String) -> Int32 {
  guard let (session, viewport) = openForBench(path) else { return 1 }
  viewport.resize(320, 240, 1)
  viewport.setPreferences(.init())
  func collect() -> Bool {
    let deadline = CACurrentMediaTime() + 60
    repeat {
      _ = viewport.draw(nil)
      if viewport.planState() == .Ready { return true }
      if viewport.planState() == .Failed { return false }
      Thread.sleep(forTimeInterval: 0.002)
    } while CACurrentMediaTime() < deadline
    return false
  }
  let start = CACurrentMediaTime()
  viewport.requestPlan()
  guard collect() else { return 1 }
  let initial = (CACurrentMediaTime() - start) * 1000
  let ready = viewport.buildTimeline()
  guard let target = ready.flights.first(where: { $0.independent && session.isLocalPiece($0.piece) })?.piece else { return 1 }
  var selection = bmapp.PieceList()
  selection.push_back(target)
  var ms: [Double] = [], undo: [Double] = []
  var incremental: [Double] = [], full: [Double] = []
  var undoCacheHits = 0
  var reused: [Int] = []
  var reusedFlightChecks: [Int] = []
  let offsets: [(Double, Double, Double)] = [(2, 0, 0), (-2, 0, 0), (0, 0, 2), (0, 0, -2), (0, 2, 0), (0, -2, 0)]
  for (x, y, z) in offsets {
    let revision = session.version()
    let started = CACurrentMediaTime()
    _ = session.move(selection, bmapp.Vec3(x: x, y: y, z: z), false)
    guard collect(), viewport.plannedVersion() > revision else { return 1 }
    let elapsed = (CACurrentMediaTime() - started) * 1000
    ms.append(elapsed)
    let timeline = viewport.buildTimeline()
    if timeline.reusedMoves > 0 { incremental.append(elapsed) } else { full.append(elapsed) }
    reused.append(Int(timeline.reusedMoves))
    reusedFlightChecks.append(Int(timeline.reusedFlightChecks))
    let restoring = CACurrentMediaTime()
    _ = session.undo()
    guard collect() else { return 1 }
    undo.append((CACurrentMediaTime() - restoring) * 1000)
    if viewport.buildTimeline().reusedSnapshot { undoCacheHits += 1 }
  }
  let pace = CACurrentMediaTime()
  _ = session.setMotionFields(.Parts, 0, selection, bmapp.MotionFields(time: 1.15, landing: -1, hover: -1, ease: -1))
  guard collect() else { return 1 }
  let timing = (CACurrentMediaTime() - pace) * 1000
  let paced = viewport.buildTimeline()
  viewport.resize(1920, 1200, 2)
  var scrubs: [Double] = []
  for sample in 0..<150 {
    let time = paced.duration * Double(sample * 13 % 150) / 150
    let start = CACurrentMediaTime()
    viewport.seek(time)
    _ = viewport.draw(nil)
    if sample >= 30 { scrubs.append((CACurrentMediaTime() - start) * 1000) }
  }
  print(json([("file", (path as NSString).lastPathComponent), ("piece", target), ("initialMs", initial),
              ("replanP95Ms", p95(ms)), ("minimumReusedMoves", reused.min() ?? 0),
              ("maximumReusedMoves", reused.max() ?? 0), ("samples", ms.count),
              ("minimumReusedFlightChecks", reusedFlightChecks.min() ?? 0), ("maximumReusedFlightChecks", reusedFlightChecks.max() ?? 0),
              ("incrementalSamples", incremental.count), ("incrementalP95Ms", p95(incremental)),
              ("fullSolveSamples", full.count), ("fullSolveP95Ms", p95(full)),
              ("undoReplanP95Ms", p95(undo)), ("undoCacheHits", undoCacheHits),
              ("timingEditMs", timing), ("timingEditReusedMoves", paced.reusedMoves),
              ("scrubP95Ms", p95(scrubs)), ("scrubSamples", scrubs.count), ("scrubSize", "1920x1200")]))
  return 0
}
