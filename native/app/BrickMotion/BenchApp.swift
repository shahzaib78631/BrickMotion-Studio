// --bench-open <file>: from the process's start to the first frame of the model drawn (the GPU
// finished with it), as JSON. --bench-edit <file>: 200 moves and 200 recolours, each timed from
// the command to its frame finished on the GPU, as JSON. Both draw into the viewport's own
// picture at the size a default window's viewport has, with nothing shown.
import AppKit
import BMApp
import Darwin

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
  var ms: [Double] = []
  var reused: [Int] = []
  for i in 0..<6 {
    let revision = session.version()
    let started = CACurrentMediaTime()
    _ = session.move(selection, bmapp.Vec3(x: i.isMultiple(of: 2) ? 2 : -2, y: 0, z: 0), false)
    guard collect(), viewport.plannedVersion() > revision else { return 1 }
    ms.append((CACurrentMediaTime() - started) * 1000)
    reused.append(Int(viewport.buildTimeline().reusedMoves))
  }
  let pace = CACurrentMediaTime()
  _ = session.setMotionFields(.Parts, 0, selection, bmapp.MotionFields(time: 1.15, landing: -1, hover: -1, ease: -1))
  guard collect() else { return 1 }
  let timing = (CACurrentMediaTime() - pace) * 1000
  print(json([("file", (path as NSString).lastPathComponent), ("piece", target), ("initialMs", initial),
              ("replanP95Ms", p95(ms)), ("minimumReusedMoves", reused.min() ?? 0),
              ("maximumReusedMoves", reused.max() ?? 0), ("samples", ms.count),
              ("timingEditMs", timing), ("timingEditReusedMoves", viewport.buildTimeline().reusedMoves)]))
  return 0
}
