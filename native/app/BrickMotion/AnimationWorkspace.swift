import AppKit
import BMApp
import Observation

enum TimelineTab: String, CaseIterable { case build = "Build", timeline = "Keyframes", motion = "Motion" }

@MainActor @Observable final class AnimationWorkspace {
  struct Flight: Identifiable, Equatable {
    let id: UInt32
    let step, depth: Int
    let colour: Int32
    let start, end: Double
    let part, flag, blocker: String
    var pinned = false
  }

  struct StepClip: Identifiable {
    let id: Int
    let start, end, pauseEnd: Double
    let flights: [Flight]
  }

  struct SubmodelClip: Identifiable {
    enum ID: Hashable { case scheduled(Int), use(UInt64) }
    let id: ID
    let depth: Int
    let start: Double
    let attach: Double?
    let end: Double
    let path: [String]
    let pieces: [UInt32]
  }

  struct Run: Identifiable {
    let id: Int
    let step: Int
    let start, end, next: Double
  }
  struct CheckResult {
    let text: String
    let warning: Bool
    var contacts: [MotionContact] = []
    var generation: UInt64 = 0
    var version: UInt64 = 0
  }

  struct MotionContact: Sendable {
    let firstFrame, lastFrame: Int
    let a, b: UInt32
    let part, blocker: String
  }

  @ObservationIgnored weak var viewport: ViewportView?
  @ObservationIgnored private let sound = TransportSound()
  @ObservationIgnored private var version: UInt64?
  @ObservationIgnored private var generation: UInt64?
  @ObservationIgnored private var stagingPreviewAt: UInt64?
  @ObservationIgnored private var pendingStep: (Int, Bool, UInt64)?
  @ObservationIgnored private var rebuildStepsAt: UInt64?
  @ObservationIgnored private var bakeVersion: UInt64?
  @ObservationIgnored private var lastBuildTime = 0.0
  private(set) var state = bmapp.PlaybackState()
  private var clockSeconds = 0.0
  private(set) var playheadRun: Int?
  private(set) var clips: [StepClip] = []
  private(set) var runs: [Run] = []
  private(set) var flights: [Flight] = []
  private(set) var submodelClips: [SubmodelClip] = []
  private(set) var diagnostics: [Flight] = []
  private(set) var notes: [String] = []
  private(set) var failure = ""
  private(set) var standardPreview = false
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
  var keySubmodel: UInt32?
  var visible = false
  private(set) var stepPreview: bmapp.AssemblyPreview?
  private(set) var checkingMotion = false
  private(set) var motionResult: CheckResult?
  private(set) var bakingFlights = false
  private(set) var bakeResult: String?
  var rate = 1.0 { didSet { viewport?.viewport.setPlaybackRate(rate) } }
  var loops = false { didSet { viewport?.viewport.setPlaybackLoop(loops) } }
  var director = false {
    didSet { viewport?.viewport.setDirectorPreview(director); viewport?.changed() }
  }
  let buildNavigation = TimelineNavigation(trailingInset: 6)
  let keyNavigation = TimelineNavigation()
  var navigation: TimelineNavigation { tab == .timeline ? keyNavigation : buildNavigation }

  var currentStep: Int? {
    if let focusedStep { return focusedStep }
    guard let playheadRun, runs.indices.contains(playheadRun) else { return nil }
    return runs[playheadRun].step
  }

  func run(at seconds: Double) -> Run? {
    guard !runs.isEmpty else { return nil }
    var lower = 0, upper = runs.count
    while lower < upper {
      let middle = lower + (upper - lower) / 2
      if runs[middle].start <= seconds { lower = middle + 1 }
      else { upper = middle }
    }
    return runs[max(0, lower - 1)]
  }

  private var showsStaleBuild: Bool { tab != .timeline && state.stale && buildDuration > 0 }
  var duration: Double { showsStaleBuild ? buildDuration : state.duration }
  var busy: Bool { state.plan == .Planning }
  var ready: Bool { state.plan == .Ready }
  var planningLabel: String {
    switch state.stage {
    case .Solving: "Solving Build Order…"
    case .CheckingFlights: "Checking Flight Paths…"
    case .Preparing: "Preparing Timeline…"
    case .StandardPreview: "Planning Standard Preview…"
    default: state.stale ? "Updating Build…" : "Planning Build…"
    }
  }
  var time: Double { showsStaleBuild ? lastBuildTime : state.atRest ? state.duration : clockSeconds }
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
    if let current = view.document?.session.version() {
      if let bakeVersion, bakeVersion != current {
        self.bakeVersion = nil
        bakeResult = nil
      }
      if let motionResult, motionResult.version != 0, motionResult.version != current {
        self.motionResult = nil
      }
    }
    let next = view.viewport.playbackState()
    if tab != .timeline, next.plan == .Ready {
      lastBuildTime = next.atRest ? next.duration : next.seconds
    }
    let statusChanged = next.plan != state.plan || next.version != state.version || next.playing != state.playing ||
       next.waitingToPlay != state.waitingToPlay || next.atRest != state.atRest || next.stale != state.stale ||
       next.duration != state.duration || next.stage != state.stage
    if statusChanged { state = next }
    if tab == .timeline { sound.pause() } else { sound.follow(next, rate: rate, viewport: view) }
    if statusChanged || Int(next.seconds * fps) != Int(clockSeconds * fps) {
      if clockSeconds != next.seconds { clockSeconds = next.seconds }
    }
    let error = next.plan == .Failed ? String(view.viewport.planError()) : ""
    if failure != error { failure = error }
    guard next.plan == .Ready, version != next.version else {
      updatePlayheadRun()
      return
    }
    let timeline = view.viewport.buildTimeline()
    version = timeline.version
    fps = timeline.framesPerSecond
    buildStart = timeline.buildStart
    buildEnd = timeline.buildEnd
    buildDuration = timeline.duration
    standardPreview = timeline.standardPreview
    notes = timeline.notes.map { String($0) }
    let pins = view.document.map { Set($0.session.arrivalPins()) } ?? []
    flights = timeline.flights.map {
      Flight(id: $0.piece, step: Int($0.step), depth: Int($0.depth), colour: $0.color, start: $0.start, end: $0.end,
             part: String($0.name), flag: String($0.flag), blocker: String($0.blocker), pinned: pins.contains($0.piece))
    }
    diagnostics = flights.filter { !$0.flag.isEmpty }
    submodelClips = resolvedSubmodels(Array(timeline.submodels), session: view.document?.session)
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
    updatePlayheadRun()
    if let expected = stagingPreviewAt {
      stagingPreviewAt = nil
      if timeline.version == expected { seek(0) }
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

  private func updatePlayheadRun() {
    let next = run(at: time)?.id
    if playheadRun != next { playheadRun = next }
  }

  private func resolvedSubmodels(_ planned: [bmapp.BuildSubmodelRow], session: bmapp.Session?) -> [SubmodelClip] {
    var clips = planned.map {
      SubmodelClip(id: .scheduled(Int($0.flight)), depth: Int($0.depth), start: $0.start, attach: $0.attach,
                   end: $0.end, path: $0.path.map { String($0) }, pieces: Array($0.pieces))
    }
    guard let session else { return clips }
    let scheduled = Set(clips.filter { $0.depth == 0 }.flatMap(\.pieces))
    let byPiece = Dictionary(flights.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    for step in 0..<Int(session.stepCount()) {
      for item in session.stepItems(step) where item.submodel {
        let ids = Array(item.pieces)
        guard !ids.isEmpty, !ids.allSatisfy(scheduled.contains) else { continue }
        let children = ids.compactMap { byPiece[$0] }
        guard let start = children.map(\.start).min(), let end = children.map(\.end).max() else { continue }
        clips.append(SubmodelClip(id: .use(item.item), depth: 0, start: start, attach: nil,
                                  end: end, path: [String(item.name)], pieces: ids))
      }
    }
    return clips
  }

  func plan() {
    viewport?.viewport.requestPlan()
    viewport?.changed()
    update()
  }

  func previewStaging() {
    tab = .build
    guard let viewport, let document = viewport.document else { return }
    if viewport.viewport.plannedVersion() == document.session.version(), ready {
      seek(0)
    } else {
      stagingPreviewAt = document.session.version()
      plan()
    }
  }

  func regenerate(standardPreview: Bool = false) {
    version = nil
    self.standardPreview = standardPreview
    viewport?.viewport.regeneratePlan(standardPreview)
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
    stagingPreviewAt = nil
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

  func editFlight(_ flight: Flight, model: DocumentModel) {
    guard ready, let view = viewport else { return }
    let session = model.document.session
    if session.hasEditableFlightKeys(flight.id) {
      openFlightKeys(flight, model: model)
      return
    }
    guard let capture = view.viewport.captureFlightBake(ViewportView.list([flight.id]), false) else {
      model.context.refuse("This part has no playable flight to open as keys.")
      return
    }
    guard !capture.replacesKeys() else {
      model.context.refuse("This flight already has keys. Open Keyframes to review them before rebaking.")
      return
    }
    let startingTab = tab
    runBake(capture, detach: false, model: model) { [weak self] model in
      guard let self, tab == startingTab else { return }
      openFlightKeys(flight, model: model)
    }
  }

  private func openFlightKeys(_ flight: Flight, model: DocumentModel) {
    let scene = model.document.session.keyScene()
    model.select(pieces: [flight.id])
    tab = .timeline
    let start = Double(scene.buildStart - scene.first) / Double(scene.fps) + flight.start / scene.buildSpeed
    seekScene(min(start, Double(scene.last - scene.first) / Double(scene.fps)))
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

  func runBake(_ source: bmapp.FlightBake, detach: Bool, model: DocumentModel,
               completion: ((DocumentModel) -> Void)? = nil) {
    guard !bakingFlights else { return }
    bakingFlights = true
    bakeResult = nil
    let work = FlightBakeSource(source)
    Task { [weak self, weak model] in
      let result = await Task.detached(priority: .userInitiated) { work.prepare() }.value
      guard let self else { return }
      bakingFlights = false
      guard let model else { return }
      guard result.error.isEmpty else {
        model.context.refuse(result.error)
        return
      }
      guard model.context.perform({ $0.applyFlightBake(work.source) }) else { return }
      bakeVersion = model.document.session.version()
      let flights = result.flights == 1 ? "1 flight" : "\(result.flights.formatted()) flights"
      let summary = "Baked \(flights) into \(result.keys.formatted()) editable keys."
      bakeResult = detach ? "\(summary) Build motion detached." : summary
      completion?(model)
    }
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
      let frames = "\(result.frames.formatted()) sampled frames"
      let label = result.intervals == 1 ? "1 contact" : "\(result.intervals.formatted()) contacts"
      let title = result.intervals == 0 ? "No crossings found in \(frames)." : "\(label) across \(frames)."
      let text = result.intervals > result.contacts.count ? "\(title) Showing the first \(result.contacts.count)." : title
      motionResult = CheckResult(text: text, warning: result.intervals > 0, contacts: result.contacts,
                                 generation: generation, version: version)
    }
  }

  func showMotionContact(_ contact: MotionContact, from report: CheckResult, model: DocumentModel) {
    let session = model.document.session
    guard session.generation() == report.generation, session.version() == report.version else {
      motionResult = CheckResult(text: "The animation changed. Run Check Motion to update these results.", warning: true)
      return
    }
    let scene = session.keyScene()
    seekScene(Double(contact.firstFrame - Int(scene.first)) / Double(scene.fps))
    model.select(pieces: [contact.a, contact.b])
    model.viewport?.frameSelection(nil)
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
    lastBuildTime = 0
    stagingPreviewAt = nil
    pendingStep = nil
    rebuildStepsAt = nil
    clips = []
    runs = []
    playheadRun = nil
    clockSeconds = 0
    flights = []
    submodelClips = []
    focusedStep = nil
    diagnostics = []
    notes = []
    motionResult = nil
    standardPreview = false
    bakeResult = nil
    bakeVersion = nil
  }
}

private final class FlightBakeSource: @unchecked Sendable {
  let source: bmapp.FlightBake
  init(_ source: bmapp.FlightBake) { self.source = source }

  struct Result: Sendable {
    let flights, keys: Int
    let error: String
  }

  func prepare() -> Result {
    let result = source.prepare()
    return Result(flights: Int(result.flights), keys: Int(result.keys), error: String(result.error))
  }
}

private final class MotionAuditSource: @unchecked Sendable {
  let source: bmapp.MotionAudit
  init(_ source: bmapp.MotionAudit) { self.source = source }

  struct Result: Sendable {
    let frames, intervals: Int
    let contacts: [AnimationWorkspace.MotionContact]
    let error: String
  }

  func check() -> Result {
    let report = source.check()
    let contacts = report.contacts.map {
      AnimationWorkspace.MotionContact(firstFrame: Int($0.firstFrame), lastFrame: Int($0.lastFrame),
                                       a: $0.a, b: $0.b, part: String($0.part), blocker: String($0.blocker))
    }
    return Result(frames: Int(report.testedFrames), intervals: Int(report.intervals), contacts: Array(contacts),
                  error: String(report.error))
  }
}
