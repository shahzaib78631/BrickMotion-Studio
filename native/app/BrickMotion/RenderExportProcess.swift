import Foundation
import os

/// Owns the helper process and the temporary output until a render succeeds.
final class RenderExportProcess: @unchecked Sendable {
  enum Result: Sendable { case rendered, cancelled, failed(String) }

  enum Operation: Sendable {
    case still, video

    var command: String { self == .still ? "still" : "--render-editor-movie" }
    var executable: URL? {
      self == .still
        ? Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/bmexport")
        : Bundle.main.executableURL
    }
  }

  enum DestinationVersion: Equatable, Sendable {
    case missing
    case file(volume: UInt64?, inode: UInt64?, modified: Date?, bytes: UInt64?)

    static func read(_ url: URL) throws -> Self {
      let files = FileManager.default
      guard files.fileExists(atPath: url.path) else { return .missing }
      let values = try files.attributesOfItem(atPath: url.path)
      return .file(volume: (values[.systemNumber] as? NSNumber)?.uint64Value,
                   inode: (values[.systemFileNumber] as? NSNumber)?.uint64Value,
                   modified: values[.modificationDate] as? Date,
                   bytes: (values[.size] as? NSNumber)?.uint64Value)
    }
  }

  static let stagingPrefix = ".brickmotion-"

  /// A job the app was rendering when it quit leaves its staging folder beside the destination.
  /// Nothing can commit it any more: remove the folders this class names, and nothing else.
  static func removeStaging(in folders: Set<URL>) {
    let files = FileManager.default
    let live = liveStaging.withLock { $0 }
    for folder in folders {
      guard let names = try? files.contentsOfDirectory(atPath: folder.path) else { continue }
      for name in names where name.hasPrefix(stagingPrefix) && !live.contains(name) &&
          UUID(uuidString: String(name.dropFirst(stagingPrefix.count))) != nil {
        try? files.removeItem(at: folder.appendingPathComponent(name, isDirectory: true))
      }
    }
  }

  /// Staging folders a render in this process is using: never swept.
  private static let liveStaging = OSAllocatedUnfairLock(initialState: Set<String>())

  private let lock = NSLock()
  private var process: Process?
  private var stopped = false

  func cancel() {
    lock.withLock {
      stopped = true
      if let process, process.isRunning { process.terminate() }
    }
  }

  func render(_ project: Data, operation: Operation, options: [String], library: String, to destination: URL,
              expected: DestinationVersion? = nil,
              finish: (@Sendable (URL) throws -> Void)? = nil,
              progress: @Sendable (Int, Int) -> Void = { _, _ in }) -> Result {
    let files = FileManager.default
    guard let executable = operation.executable, files.isExecutableFile(atPath: executable.path) else {
      return .failed("The render helper is missing from the app bundle.")
    }
    let directory = files.temporaryDirectory.appendingPathComponent("BrickMotion-\(UUID())", isDirectory: true)
    let staging = destination.deletingLastPathComponent()
      .appendingPathComponent(Self.stagingPrefix + UUID().uuidString, isDirectory: true)
    let output = staging.appendingPathComponent("Render").appendingPathExtension(destination.pathExtension)
    do {
      let initial = try DestinationVersion.read(destination)
      let version = expected ?? initial
      let updatedDestination = "A different version of the file is at the destination. Choose a new location and export again."
      guard initial == version else { return .failed(updatedDestination) }
      try files.createDirectory(at: directory, withIntermediateDirectories: false)
      defer { try? files.removeItem(at: directory) }
      Self.liveStaging.withLock { _ = $0.insert(staging.lastPathComponent) }
      defer { Self.liveStaging.withLock { _ = $0.remove(staging.lastPathComponent) } }
      try files.createDirectory(at: staging, withIntermediateDirectories: false)
      defer { try? files.removeItem(at: staging) }
      let input = directory.appendingPathComponent("Model.brickmotion")
      try project.write(to: input, options: .atomic)
      let task = Process()
      let events = Pipe()
      task.executableURL = executable
      task.arguments = [operation.command, input.path, "--out", output.path] + options
      task.environment = ProcessInfo.processInfo.environment.merging(["BM_LDRAW_DIR": library]) { _, selected in selected }
      task.standardError = events
      task.standardOutput = events
      try lock.withLock {
        if stopped { throw CancellationError() }
        try task.run()
        process = task
      }

      var pending = Data()
      var diagnostics: [String] = []
      func consume(_ bytes: Data.SubSequence) {
        let line = String(decoding: bytes, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        let fields = line.split(separator: " ")
        if fields.count == 3, fields[0] == "frame", let done = Int(fields[1]), let total = Int(fields[2]), done > 0, done <= total {
          progress(done, total)
        } else if !line.isEmpty {
          diagnostics.append(String(line.prefix(1200)))
          if diagnostics.count > 4 { diagnostics.removeFirst() }
        }
      }
      while true {
        let chunk = events.fileHandleForReading.availableData
        if chunk.isEmpty { break }
        pending.append(chunk)
        while let end = pending.firstIndex(of: 10) {
          consume(pending[..<end])
          pending.removeSubrange(...end)
        }
        if pending.count > 8192 { pending = Data(pending.suffix(8192)) }
      }
      if !pending.isEmpty { consume(pending[...]) }
      task.waitUntilExit()
      let cancelled = lock.withLock {
        process = nil
        return stopped
      }
      if cancelled { return .cancelled }
      if task.terminationStatus != 0 {
        return .failed(diagnostics.last ?? "The exporter stopped with status \(task.terminationStatus).")
      }
      try finish?(output)  // e.g. the logo over a still, before anything reaches the destination
      guard try DestinationVersion.read(destination) == version else { return .failed(updatedDestination) }
      if version == .missing {
        try files.moveItem(at: output, to: destination)
      } else {
        _ = try files.replaceItemAt(destination, withItemAt: output)
      }
      return .rendered
    } catch is CancellationError {
      return .cancelled
    } catch {
      return .failed(error.localizedDescription)
    }
  }
}
