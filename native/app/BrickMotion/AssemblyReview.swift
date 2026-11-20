import BMApp
import Observation

@MainActor @Observable final class AssemblyReview {
  enum Selection { case connected, rigid, touching }

  private struct Revision: Equatable {
    let generation: UInt64
    let version: UInt64
    let structure: UInt64
    let hidden: [UInt32]
  }
  private struct Request: Equatable {
    let revision: Revision
    let selection: [UInt32]
    let joints, geometry: Bool
  }

  private(set) var report: AssemblyInspectionWorker.Report?
  private(set) var loading = false
  private(set) var fitting = false
  private(set) var changing = false
  private(set) var jointError: String?
  var joint: bmapp.JointRow?
  @ObservationIgnored private var source: AssemblyInspectionWorker.Source?
  @ObservationIgnored private var sourceRevision: Revision?
  @ObservationIgnored private var request: Request?
  @ObservationIgnored private var task: Task<Void, Never>?
  @ObservationIgnored private let worker = AssemblyInspectionWorker()

  func update(_ model: DocumentModel) {
    let selection = Array(model.snapshot.selection)
    guard !selection.isEmpty || model.showJoints || joint != nil else {
      task?.cancel()
      task = nil
      request = nil
      report = nil
      loading = false
      joint = nil
      return
    }
    let session = model.document.session
    let revision = revisionOf(session)
    let oldJoint = request?.revision.generation == revision.generation &&
      request?.revision.structure == revision.structure ? joint : nil
    let next = Request(revision: revision, selection: selection, joints: model.showJoints || oldJoint != nil, geometry: selection.count == 1)
    guard request != next, let source = capture(session, revision: revision) else { return }
    request = next
    task?.cancel()
    report = nil
    joint = oldJoint
    loading = true
    task = Task { [weak self, weak model, worker] in
      let result = await worker.inspect(source, selection: selection, joints: next.joints, geometry: next.geometry)
      guard !Task.isCancelled, let self, request == next else { return }
      report = result
      if let open = joint, let result { joint = result.joints.first { $0.a == open.a && $0.b == open.b } }
      loading = false
      model?.viewport?.updateEditorOverlays()
    }
  }

  func openJoint(_ value: bmapp.JointRow?) {
    joint = value
    jointError = nil
  }

  func changeJoint(_ model: DocumentModel, degrees: Double) {
    guard let joint, !changing else { return }
    let session = model.document.session
    let revision = revisionOf(session)
    guard let source = capture(session, revision: revision) else { return }
    let collision = model.viewport?.collisionChecks ?? true
    changing = true
    jointError = nil
    Task { [weak self, weak model, worker] in
      let result = await worker.change(source, fixed: joint.a, moving: joint.b, degrees: degrees, collision: collision)
      guard let self else { return }
      changing = false
      guard let model, let result, revision == revisionOf(session), self.joint?.a == joint.a, self.joint?.b == joint.b else { return }
      guard result.error.isEmpty else { jointError = result.error; return }
      guard result.pieces.allSatisfy({ session.isLocalPiece($0) }) else {
        jointError = "Open the submodel that contains this connection."
        return
      }
      model.context.perform {
        $0.placeMoved(ViewportView.list(result.pieces), result.pivot, result.pose, revision.generation, revision.version)
      }
    }
  }

  func select(_ sense: Selection, model: DocumentModel) {
    let session = model.document.session
    let revision = revisionOf(session)
    let selection = Array(session.selection())
    guard !selection.isEmpty, let source = capture(session, revision: revision) else { return }
    Task { [weak model, worker] in
      let result = await worker.inspect(source, selection: selection, joints: false, geometry: sense == .touching)
      guard let model, let report = result, revision == revisionOf(session),
            Array(session.selection()) == selection else { return }
      if !report.error.isEmpty { return model.context.refuse(report.error) }
      let selected = switch sense {
      case .connected: report.connected
      case .touching: report.touching
      case .rigid: report.rigid
      }
      model.select(pieces: selected)
    }
  }

  func selectBody(piece: UInt32, model: DocumentModel) {
    let session = model.document.session
    let revision = revisionOf(session)
    guard let source = capture(session, revision: revision) else { return }
    Task { [weak model, worker] in
      let pieces = await worker.body(source, piece: piece)
      if let model, revision == revisionOf(session) { model.select(pieces: pieces) }
    }
  }

  func fit(model: DocumentModel, choose: Bool) {
    let session = model.document.session
    let pieces = Array(session.selection())
    guard pieces.count == 2, !fitting else { return }
    guard pieces.allSatisfy({ session.isLocalPiece($0) }) else {
      return model.context.refuse("Open the submodel to fit the pieces inside it.")
    }
    let revision = revisionOf(session)
    guard let source = capture(session, revision: revision) else { return }
    fitting = true
    Task { [weak self, weak model, worker] in
      let fits = await worker.fits(source, moving: pieces[1], target: pieces[0]).values
      guard let self else { return }
      fitting = false
      guard let model, revisionOf(session) == revision, Array(session.selection()) == pieces else { return }
      guard !fits.isEmpty else { return model.context.refuse("No clear connector placement was found for these pieces.") }
      @MainActor func apply(_ index: Int) {
        guard fits.indices.contains(index), revisionOf(session) == revision else { return }
        model.context.perform {
          $0.placeMoved(ViewportView.list([pieces[1]]), pieces[1], fits[index].pose, revision.generation, revision.version)
        }
      }
      if choose && fits.count > 1 {
        FitSheet.show(fits, moving: pieces[1], model: model, apply: { index in apply(index) })
      } else {
        apply(0)
      }
    }
  }

  private func revisionOf(_ session: bmapp.Session) -> Revision {
    Revision(generation: session.generation(), version: session.version(), structure: session.structureVersion(), hidden: Array(session.hidden()))
  }

  private func capture(_ session: bmapp.Session, revision: Revision) -> AssemblyInspectionWorker.Source? {
    if sourceRevision == revision { return source }
    sourceRevision = revision
    if let captured = bmapp.AssemblyInspection.capture(session) {
      source = AssemblyInspectionWorker.Source(captured)
    } else {
      source = nil
    }
    return source
  }
}
