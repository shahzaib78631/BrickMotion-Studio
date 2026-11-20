import AppKit
import BMApp
import Observation

enum TimelineTab: String, CaseIterable { case build = "Build", timeline = "Timeline", motion = "Motion" }

@MainActor @Observable final class AnimationWorkspace {
  struct Flight: Identifiable {
    let id: UInt32
    let step, depth: Int
    let start, end: Double
    let part, flag, blocker: String
  }

  struct StepClip: Identifiable {
    let id: Int
    let start, end, pauseEnd: Double
    let flights: [Flight]
  }

  struct Run: Identifiable {
    let id: Int
    let step: Int
    let start, end, next: Double
  }
  struct CheckResult {
    let text: String
    let warning: Bool
  }

  @ObservationIgnored weak var viewport: ViewportView?
  @ObservationIgnored private var version: UInt64?
  @ObservationIgnored private var generation: UInt64?
  @ObservationIgnored private var pendingStep: (Int, Bool, UInt64)?
  @ObservationIgnored private var rebuildStepsAt: UInt64?
  private(set) var state = bmapp.PlaybackState()
  private(set) var clips: [StepClip] = []
  private(set) var runs: [Run] = []
  private(set) var flights: [Flight] = []
  private(set) var diagnostics: [Flight] = []
  private(set) var notes: [String] = []
  private(set) var failure = ""
  private(set) var fps = 30.0
  private(set) var buildStart = 0.0
  private(set) var buildEnd = 0.0
  private(set) var buildDuration = 0.0
  var focusedStep: Int?
  var tab = TimelineTab.build {
    didSet {
      guard oldValue != tab, let viewport else { return }
      viewport.viewport.useKeyframes(tab == .timeline)
      viewport.changed()
      update()
    }
  }
  var autoKey = false
  var visible = false
  private(set) var stepPreview: bmapp.AssemblyPreview?
  private(set) var checkingMotion = false
  private(set) var motionResult: CheckResult?
  var rate = 1.0 { didSet { viewport?.viewport.setPlaybackRate(rate) } }
  var loops = false { didSet { viewport?.viewport.setPlaybackLoop(loops) } }
  var director = false {
    didSet { viewport?.viewport.setDirectorPreview(director); viewport?.changed() }
  }
  var zoom = 1.0

  var currentStep: Int? {
    if let focusedStep { return focusedStep }
    return runs.last { $0.start <= state.seconds }?.step ?? runs.first?.step
  }

  var duration: Double { state.duration }
  var busy: Bool { state.plan == .Planning }
  var ready: Bool { state.plan == .Ready }
  var time: Double { state.atRest ? state.duration : state.seconds }
  var isKeyEditing: Bool { visible && tab == .timeline }
  var previewName: String {
    switch stepPreview {
    case .Assembled: "Assembled"
    case .Separated: "Separated"
    case .LaidOut: "Laid Out"
    case .Exploded: "Exploded"
    default: "Step Appearance"
    }
  }

  func update() {
    guard let view = viewport else { return }
    if let next = view.document?.session.generation(), next != generation {
      reset()
      generation = next
    }
    let next = view.viewport.playbackState()
    if next.plan != state.plan || next.version != state.version || next.playing != state.playing ||
       next.waitingToPlay != state.waitingToPlay || next.atRest != state.atRest || next.stale != state.stale ||
       next.duration != state.duration ||
       Int(next.seconds * fps) != Int(state.seconds * fps) {
      state = next
    }
    failure = next.plan == .Failed ? String(view.viewport.planError()) : ""
    guard next.plan == .Ready, version != next.version else { return }
    let timeline = view.viewport.buildTimeline()
    version = timeline.version
    fps = timeline.framesPerSecond
    buildStart = timeline.buildStart
    buildEnd = timeline.buildEnd
    buildDuration = timeline.duration
    notes = timeline.notes.map { String($0) }
    flights = timeline.flights.map {
      Flight(id: $0.piece, step: Int($0.step), depth: Int($0.depth), start: $0.start, end: $0.end,
             part: String($0.name), flag: String($0.flag), blocker: String($0.blocker))
    }
    diagnostics = flights.filter { !$0.flag.isEmpty }
    var seams: [(step: Int, start: Double, end: Double)] = []
    for flight in flights {
      if let last = seams.indices.last,
         seams[last].step == flight.step || flight.start < seams[last].end {
        seams[last].end = max(seams[last].end, flight.end)
      } else {
        seams.append((flight.step, flight.start, flight.end))
      }
    }
    runs = seams.enumerated().map { index, seam in
      let next = seams.indices.contains(index + 1) ? seams[index + 1].start : timeline.buildEnd
      return Run(id: index, step: seam.step, start: seam.start, end: seam.end, next: max(seam.end, next))
    }
    let bounds = Dictionary(grouping: flights, by: \.step).compactMap { step, items -> StepClip? in
      guard let start = items.first?.start, let end = items.map(\.end).max() else { return nil }
      return StepClip(id: step, start: start, end: end, pauseEnd: end, flights: items)
    }.sorted { $0.start < $1.start }
    clips = bounds.enumerated().map { index, step in
      let next = bounds.indices.contains(index + 1) ? bounds[index + 1].start : timeline.duration
      return StepClip(id: step.id, start: step.start, end: step.end,
                      pauseEnd: max(step.end, next), flights: step.flights)
    }
    if let (step, throughEnd, expected) = pendingStep {
      pendingStep = nil
      if timeline.version == expected { play(step: step, throughEnd: throughEnd) }
    }
    if let expected = rebuildStepsAt {
      rebuildStepsAt = nil
      if view.document?.session.version() == expected { applyStepOrder() }
    }
  }

  func plan() {
    viewport?.viewport.requestPlan()
    viewport?.changed()
    update()
  }

  func regenerate() {
    version = nil
    viewport?.viewport.regeneratePlan()
    viewport?.changed()
    update()
  }

  func regenerateSteps() {
    guard let view = viewport, let document = view.document else { return }
    if ready {
      applyStepOrder()
    } else {
      rebuildStepsAt = document.session.version()
      plan()
    }
  }

  private func applyStepOrder() {
    guard let view = viewport, let document = view.document else { return }
    let order = view.viewport.buildOrder()
    if order.isEmpty { return }
    document.perform { document.session.regenerateSteps(order) }
    view.changed()
  }

  func togglePlayback() {
    guard let viewport else { return }
    viewport.placement.cancel()
    stepPreview = nil
    viewport.viewport.play(!state.playing && !state.waitingToPlay)
    viewport.changed()
    update()
  }

  func rest() {
    pendingStep = nil
    focusedStep = nil
    stepPreview = nil
    viewport?.viewport.showRest()
    viewport?.changed()
    update()
  }

  func seek(_ time: Double) {
    guard ready else { return }
    focusedStep = nil
    stepPreview = nil
    let frame = (time * fps).rounded()
    viewport?.viewport.seek(frame / fps)
    viewport?.changed()
    update()
  }

  func seekScene(_ time: Double) {
    viewport?.viewport.seek(time)
    viewport?.changed()
    update()
  }

  func arrange(step: Int, mode: bmapp.AssemblyPreview) {
    guard let viewport else { return }
    viewport.placement.cancel()
    focusedStep = step >= 0 ? step : nil
    stepPreview = mode
    viewport.viewport.arrange(Int32(step), mode)
    viewport.changed()
    update()
  }

  func checkMotion(model: DocumentModel) {
    guard !checkingMotion, let viewport, let piece = model.snapshot.selection.first,
          let audit = viewport.viewport.auditMotion(piece) else { return }
    checkingMotion = true
    motionResult = nil
    let generation = model.document.session.generation(), version = model.document.session.version()
    let source = MotionAuditSource(audit)
    Task { [weak self, weak model] in
      let result = await Task.detached(priority: .userInitiated) { source.check() }.value
      guard let self else { return }
      checkingMotion = false
      guard let model, model.document.session.generation() == generation, model.document.session.version() == version else {
        motionResult = CheckResult(text: "The animation changed while it was being checked.", warning: true)
        return
      }
      if !result.error.isEmpty {
        motionResult = CheckResult(text: result.error, warning: true)
        return
      }
      if result.frame >= 0 {
        if model.snapshot.selection.contains(piece) {
          let scene = model.document.session.keyScene()
          seekScene(Double(result.frame - Int(scene.first)) / Double(scene.fps))
          model.select(pieces: result.pieces)
          model.viewport?.frameSelection(nil)
        }
        motionResult = CheckResult(text: "Frame \(result.frame) · \(displayName(result.part)) crosses \(displayName(result.blocker))",
                                   warning: true)
      } else {
        motionResult = CheckResult(text: "No crossings found in \(result.count) sampled frames.", warning: false)
      }
    }
  }

  func travel(forward: Bool) {
    let candidates = runs.map(\.start)
    seek(forward ? candidates.first { $0 > time + 0.02 } ?? duration :
      candidates.last { $0 < time - 0.02 } ?? 0)
  }

  func select(step: Int) {
    if let clip = clips.first(where: { $0.id == step }) { seek(clip.end) }
    focusedStep = step
  }

  func select(run: Run) {
    seek(run.end)
    focusedStep = run.step
  }

  func nearestFlight(at seconds: Double, depth: Bool) -> Flight? {
    var low = 0, high = flights.count
    while low < high {
      let middle = (low + high) / 2
      if flights[middle].start < seconds { low = middle + 1 } else { high = middle }
    }
    return flights.dropFirst(max(0, low - 8)).prefix(16)
      .filter { ($0.depth > 0) == depth }
      .min {
        let a = max($0.start - seconds, seconds - $0.end, 0)
        let b = max($1.start - seconds, seconds - $1.end, 0)
        return a == b ? abs($0.start - seconds) < abs($1.start - seconds) : a < b
      }
  }

  func play(step: Int, throughEnd: Bool = false) {
    guard let viewport else { return }
    focusedStep = step
    stepPreview = nil
    guard ready else {
      if let version = viewport.document?.session.version() { pendingStep = (step, throughEnd, version) }
      plan()
      return
    }
    guard let clip = clips.first(where: { $0.id == step }) else { return }
    viewport.viewport.playRange(clip.start, throughEnd ? 0 : max(clip.start + 1 / fps, clip.end))
    viewport.changed()
    update()
  }

  func reset() {
    version = nil
    pendingStep = nil
    rebuildStepsAt = nil
    clips = []
    runs = []
    flights = []
    focusedStep = nil
    diagnostics = []
    notes = []
  }
}

private final class MotionAuditSource: @unchecked Sendable {
  let source: bmapp.MotionAudit
  init(_ source: bmapp.MotionAudit) { self.source = source }

  struct Result: Sendable {
    let frame, count: Int
    let pieces: [UInt32]
    let part, blocker, error: String
  }

  func check() -> Result {
    let report = source.check()
    return Result(frame: Int(report.collisionFrame), count: Int(report.testedFrames), pieces: [report.a, report.b],
                  part: String(report.part), blocker: String(report.blocker), error: String(report.error))
  }
}
