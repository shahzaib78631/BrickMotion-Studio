import AppKit
import BMApp
import Observation

@MainActor @Observable final class RenderJob: Identifiable {
  enum Status: Codable, Equatable {
    case queued, rendering(done: Int, total: Int), cancelling
    case complete, cancelled, interrupted, failed(String)

    var finished: Bool {
      switch self {
      case .queued, .rendering, .cancelling: false
      default: true
      }
    }
  }

  struct Record: Codable, Identifiable {
    let id: UUID
    let destination: URL
    let summary: String
    var status: Status
  }

  let id: UUID
  let destination: URL
  let summary: String
  fileprivate(set) var status: Status

  fileprivate var record: Record { Record(id: id, destination: destination, summary: summary, status: status) }

  fileprivate init(_ record: Record) {
    id = record.id
    destination = record.destination
    summary = record.summary
    status = record.status
  }
}

/// Run one helper at a time to limit contention with the editor.
@MainActor @Observable final class RenderQueue {
  static let shared = RenderQueue(history: .standard)
  private static let historyKey = "renderQueueHistory"

  private struct Request: Sendable {
    let project: Data
    let operation: RenderExportProcess.Operation
    let options: [String]
    let library: String
    let destination: URL
    let expected: RenderExportProcess.DestinationVersion
    var finish: (@Sendable (URL) throws -> Void)? = nil
  }

  struct BatchMovie {
    let name: String
    let options: [String]
    let summary: String
  }

  private(set) var jobs: [RenderJob]
  @ObservationIgnored private let history: UserDefaults
  @ObservationIgnored private var pending: [(RenderJob, Request)] = []
  @ObservationIgnored private var active: RenderExportProcess?

  init(history: UserDefaults) {
    self.history = history
    if let data = history.data(forKey: Self.historyKey), let records = try? JSONDecoder().decode([RenderJob.Record].self, from: data) {
      jobs = records.map { record in
        var snapshot = record
        if !snapshot.status.finished { snapshot.status = .interrupted }
        return RenderJob(snapshot)
      }
      let abandoned = Set(records.filter { !$0.status.finished }.map { $0.destination.deletingLastPathComponent() })
      // Before any new job stages beside the same destinations.
      RenderExportProcess.removeStaging(in: abandoned)
      if !abandoned.isEmpty { saveHistory() }
    } else {
      jobs = []
    }
  }

  var hasFinishedJobs: Bool { jobs.contains { $0.status.finished } }

  func enqueue(_ project: Data, operation: RenderExportProcess.Operation, options: [String], library: String,
               destination: URL, summary: String, finish: (@Sendable (URL) throws -> Void)? = nil) throws -> RenderJob {
    let path = Self.key(destination)
    let reserved = jobs.contains { !$0.status.finished && Self.key($0.destination) == path }
    guard !reserved else {
      throw NSError(domain: "BrickMotion.RenderQueue", code: 1, userInfo: [
        NSLocalizedDescriptionKey: "An export is already using that destination. Choose another file name."
      ])
    }
    let expected = try RenderExportProcess.DestinationVersion.read(destination)
    let request = Request(project: project, operation: operation, options: options, library: library,
                          destination: destination, expected: expected, finish: finish)
    let job = add(request, summary: summary)
    saveHistory()
    startNext()
    return job
  }

  /// Folder selection authorizes new files. Numbered names leave existing movies in place.
  func enqueueMovies(_ movies: [BatchMovie], project: Data, library: String, in folder: URL) {
    guard !movies.isEmpty else { return }
    let files = FileManager.default
    let key = Self.key
    var reserved = Set(jobs.lazy.filter { !$0.status.finished }.map { key($0.destination) })
    for movie in movies {
      let stem = String(bmapp.safeFileStem(std.string(movie.name)))
      var destination = folder.appendingPathComponent(stem).appendingPathExtension("mp4")
      var suffix = 2
      while reserved.contains(key(destination)) || files.fileExists(atPath: destination.path) {
        destination = folder.appendingPathComponent("\(stem) \(suffix)").appendingPathExtension("mp4")
        suffix += 1
      }
      reserved.insert(key(destination))
      let request = Request(project: project, operation: .video, options: movie.options, library: library,
                            destination: destination, expected: .missing)
      _ = add(request, summary: movie.summary)
    }
    saveHistory()
    startNext()
  }

  /// macOS volumes are case-insensitive by default: two spellings of one name are one file.
  private static func key(_ url: URL) -> String { url.standardizedFileURL.resolvingSymlinksInPath().path.lowercased() }

  private func add(_ request: Request, summary: String) -> RenderJob {
    let job = RenderJob(.init(id: UUID(), destination: request.destination, summary: summary, status: .queued))
    jobs.insert(job, at: 0)
    pending.append((job, request))
    return job
  }

  func cancel(_ job: RenderJob) {
    switch job.status {
    case .queued:
      pending.removeAll { $0.0 === job }
      job.status = .cancelled
      saveHistory()
    case .rendering:
      job.status = .cancelling
      active?.cancel()
      saveHistory()
    default: break
    }
  }

  func clearFinished() {
    jobs.removeAll { $0.status.finished }
    saveHistory()
  }

  func stopForQuit() { active?.cancel() }

  private func startNext() {
    guard active == nil, !pending.isEmpty else { return }
    let (job, request) = pending.removeFirst()
    let worker = RenderExportProcess()
    active = worker
    job.status = .rendering(done: 0, total: 0)
    saveHistory()
    Task { @MainActor in
      let outcome = await Task.detached(priority: .utility) {
        worker.render(request.project, operation: request.operation, options: request.options,
                      library: request.library, to: request.destination, expected: request.expected,
                      finish: request.finish) { done, total in
          Task { @MainActor in
            if case .rendering(let last, _) = job.status, done >= last {
              job.status = .rendering(done: done, total: total)
            }
          }
        }
      }.value
      switch outcome {
      case .rendered: job.status = .complete
      case .cancelled: job.status = .cancelled
      case .failed(let reason): job.status = .failed(reason)
      }
      active = nil
      saveHistory()
      startNext()
    }
  }

  private func saveHistory() {
    let active = jobs.filter { !$0.status.finished }
    let recent = jobs.lazy.filter { $0.status.finished }.prefix(40)
    let records = active.map(\.record) + recent.map(\.record)
    if let data = try? JSONEncoder().encode(records) { history.set(data, forKey: Self.historyKey) }
  }
}
