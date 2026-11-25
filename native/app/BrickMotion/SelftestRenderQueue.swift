import BMApp
import Foundation
import ImageIO

@MainActor func selftestRenderQueue() -> Int32 {
  let files = FileManager.default
  let id = "BrickMotion.QueuedExportTest.\(UUID())"
  let folder = files.temporaryDirectory.appendingPathComponent(id, isDirectory: true)
  guard let history = UserDefaults(suiteName: id) else { return 1 }
  defer {
    history.removePersistentDomain(forName: id)
    try? files.removeItem(at: folder)
  }

  func check(_ passes: Bool, _ message: String) throws {
    guard passes else {
      throw NSError(domain: id, code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
  }

  do {
    try files.createDirectory(at: folder, withIntermediateDirectories: false)
    let queue = RenderQueue(history: history)
    let project = Data("""
      {"format":"brickmotion-project","version":1,"plan":
       {"format":"brickmotion-plan","version":1,"steps":[{"pieces":[
        {"id":"part","part":"3001.dat","color":4,"ldu":[0,0,0],"matrix":[1,0,0,0,1,0,0,0,1]},
        {"id":"outer","submodel":"Outer","x":3,"y":0,"z":0,"rot":0}]}],
        "submodels":{
          "Outer":{"steps":[{"pieces":[{"id":"inner","submodel":"Inner","x":0,"y":0,"z":0,"rot":0}]}]},
          "Inner":{"steps":[{"pieces":[{"id":"plate","part":"3022.dat","color":14,"x":0,"y":0,"z":0,"rot":0}]}]},
          "Spare":{"steps":[{"pieces":[{"id":"brick","part":"3001.dat","color":1,"x":0,"y":0,"z":0,"rot":0}]}]}}}}
      """.utf8)
    let library = String(bmapp.Session.ldrawDirectory())
    let firstURL = folder.appendingPathComponent("First.mp4")
    let conflictURL = folder.appendingPathComponent("Changed.mp4")
    let cancelledURL = folder.appendingPathComponent("Cancelled.mp4")
    let options = ["--source", "turntable", "--duration", "1", "--size", "320x180", "--fps", "24"]
    func enqueue(_ url: URL) throws -> RenderJob {
      try queue.enqueue(project, operation: .video, options: options, library: library,
                        destination: url, summary: "Turntable")
    }
    let first = try enqueue(firstURL)
    do {
      _ = try enqueue(firstURL)
      try check(false, "The queue accepted two jobs for one destination.")
    } catch {
      if (error as NSError).domain == id { throw error }
    }
    try Data("original".utf8).write(to: conflictURL)
    let conflict = try enqueue(conflictURL)
    let cancelled = try enqueue(cancelledURL)
    try check(conflict.status == .queued && cancelled.status == .queued, "The queue launched overlapping renders.")
    let reloaded = RenderQueue(history: history)
    try check(reloaded.jobs.allSatisfy { $0.status == .interrupted }, "Unfinished exports were not recovered as interrupted.")
    queue.cancel(cancelled)
    let replacement = Data("new file at the chosen destination".utf8)
    try replacement.write(to: conflictURL, options: .atomic)

    let deadline = Date().addingTimeInterval(30)
    while queue.jobs.contains(where: { !$0.status.finished }) && Date() < deadline {
      RunLoop.main.run(until: Date().addingTimeInterval(0.025))
    }
    try check(first.status == .complete, "The first render did not complete. \(first.status)")
    try check(cancelled.status == .cancelled && !files.fileExists(atPath: cancelledURL.path),
              "A cancelled job wrote a file.")
    guard case .failed = conflict.status else {
      try check(false, "The changed destination was overwritten.")
      return 1
    }
    try check(try Data(contentsOf: conflictURL) == replacement, "The replacement file was changed.")
    try check(files.fileExists(atPath: firstURL.path), "The finished movie is missing.")
    try check(RenderQueue(history: history).jobs.count == 3, "Render history did not persist.")
    queue.clearFinished()
    try check(RenderQueue(history: history).jobs.isEmpty, "Cleared history was restored.")

    let existing = folder.appendingPathComponent("Wheel.mp4")
    try replacement.write(to: existing)
    queue.enqueueMovies([
      RenderQueue.BatchMovie(name: "Wheel", options: options + ["--model", "Outer", "--model", "Inner"], summary: "Nested"),
      RenderQueue.BatchMovie(name: "Wheel", options: options + ["--model", "Spare"], summary: "Unused")
    ], project: project, library: library, in: folder)
    let batchDeadline = Date().addingTimeInterval(30)
    while queue.jobs.contains(where: { !$0.status.finished }) && Date() < batchDeadline {
      RunLoop.main.run(until: Date().addingTimeInterval(0.025))
    }
    try check(queue.jobs.count == 2 && queue.jobs.allSatisfy { $0.status == .complete },
              "A scoped movie failed. \(queue.jobs.map(\.status))")
    try check(Set(queue.jobs.map { $0.destination.lastPathComponent }) == ["Wheel 2.mp4", "Wheel 3.mp4"],
              "The batch did not reserve distinct names.")
    try check(try Data(contentsOf: existing) == replacement, "The batch changed an existing movie.")

    // A still with the logo stamped in its corner before it reaches the destination.
    let logoURL = folder.appendingPathComponent("Logo.png")
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let green = CGContext(data: nil, width: 40, height: 20, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    green.setFillColor(CGColor(srgbRed: 0, green: 1, blue: 0, alpha: 1))
    green.fill(CGRect(x: 0, y: 0, width: 40, height: 20))
    let logoOut = CGImageDestinationCreateWithURL(logoURL as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(logoOut, green.makeImage()!, nil)
    try check(CGImageDestinationFinalize(logoOut), "The logo fixture could not be written.")
    let stillURL = folder.appendingPathComponent("Cover.png")
    let stamp = VideoLogo.Stamp(file: logoURL, corner: .bottomRight)
    let still = try queue.enqueue(project, operation: .still, options: ["--size", "216x216", "--samples", "2", "--no-denoise"],
                                  library: library, destination: stillURL, summary: "Still",
                                  finish: { try stamp.apply(to: $0) })
    let stillDeadline = Date().addingTimeInterval(60)
    while !still.status.finished && Date() < stillDeadline { RunLoop.main.run(until: Date().addingTimeInterval(0.025)) }
    try check(still.status == .complete, "The still did not render. \(still.status)")
    guard let source = CGImageSourceCreateWithURL(stillURL as CFURL, nil),
          let picture = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw NSError(domain: id, code: 2) }
    let probe = CGContext(data: nil, width: picture.width, height: picture.height, bitsPerComponent: 8, bytesPerRow: picture.width * 4,
                          space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    probe.draw(picture, in: CGRect(x: 0, y: 0, width: picture.width, height: picture.height))
    let bytes = probe.data!.assumingMemoryBound(to: UInt8.self)
    func rgb(_ x: Int, _ y: Int) -> (Int, Int, Int) {  // y from the top
      let i = (y * picture.width + x) * 4
      return (Int(bytes[i]), Int(bytes[i + 1]), Int(bytes[i + 2]))
    }
    // 216 square: the logo is 47.5 wide, 23.8 high, 9.6 in from the right and bottom.
    let (r, g, b) = rgb(216 - 10 - 20, 216 - 10 - 10)
    try check(g > 180 && r < 90 && b < 90, "The logo is not in the still's corner (\(r), \(g), \(b)).")
    let (r2, g2, b2) = rgb(20, 20)
    try check(!(g2 > 180 && r2 < 90 && b2 < 90), "The logo appeared outside its corner.")

    // Staging left by a render the app was running when it quit is removed on relaunch.
    let orphan = folder.appendingPathComponent(RenderExportProcess.stagingPrefix + UUID().uuidString, isDirectory: true)
    let unrelated = folder.appendingPathComponent(".brickmotion-notes", isDirectory: true)
    try files.createDirectory(at: orphan, withIntermediateDirectories: false)
    try files.createDirectory(at: unrelated, withIntermediateDirectories: false)
    let record = RenderJob.Record(id: UUID(), destination: folder.appendingPathComponent("Lost.mp4"), summary: "Lost",
                                  status: .rendering(done: 1, total: 2))
    history.set(try JSONEncoder().encode([record]), forKey: "renderQueueHistory")
    let relaunched = RenderQueue(history: history)
    try check(!files.fileExists(atPath: orphan.path), "An abandoned staging folder was left behind.")
    try check(files.fileExists(atPath: unrelated.path), "A folder the queue did not make was removed.")
    try check(relaunched.jobs.first?.status == .interrupted, "The abandoned job was not marked interrupted.")
  } catch {
    print("selftest-render-queue: \(error.localizedDescription)")
    return 1
  }
  print("selftest-render-queue: ok")
  return 0
}
