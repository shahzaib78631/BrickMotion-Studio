import BMApp

actor AssemblyInspectionWorker {
  // The immutable native model is captured on the main actor. This actor is the only executor
  // that queries its lazily built caches.
  final class Source: @unchecked Sendable {
    let native: bmapp.AssemblyInspection
    init(_ native: bmapp.AssemblyInspection) { self.native = native }
  }
  struct Report: @unchecked Sendable {
    let joints: [bmapp.JointRow]
    let overlaps: [bmapp.OverlapRow]
    let connected, rigid, touching, withoutConnectors: [UInt32]
    let error: String
  }
  struct Fits: @unchecked Sendable { let values: [bmapp.FitPose] }
  struct JointChange: @unchecked Sendable {
    let pieces: [UInt32]
    let pivot: UInt32
    let pose: bmapp.PartPose
    let error: String
  }

  func inspect(_ source: Source, selection: [UInt32], joints: Bool, geometry: Bool) -> Report? {
    guard !Task.isCancelled else { return nil }
    var pieces = bmapp.PieceList()
    for piece in selection { pieces.push_back(piece) }
    let report = source.native.inspect(pieces, joints, geometry)
    return Report(joints: Array(report.joints), overlaps: Array(report.overlaps),
                  connected: Array(report.connected), rigid: Array(report.rigid), touching: Array(report.touching),
                  withoutConnectors: Array(report.withoutConnectors), error: String(report.error))
  }

  func checkModel(_ source: Source) -> ModelChecksResult {
    let checks = source.native.checkModel()
    return ModelChecksResult(findings: checks.findings.enumerated().compactMap { index, row in
      guard let kind = ModelChecksResult.Kind(native: row.kind) else { return nil }
      return ModelChecksResult.Finding(id: index, kind: kind, title: String(row.title), detail: String(row.detail), pieces: Array(row.pieces))
    }, error: String(checks.error))
  }

  struct Loose: @unchecked Sendable {
    let pieces: [bmapp.LoosePiece]
    let error: String
  }

  func loosePieces(_ source: Source) -> Loose {
    guard !Task.isCancelled else { return Loose(pieces: [], error: "") }
    let found = source.native.loosePieces()
    return Loose(pieces: Array(found.pieces), error: String(found.error))
  }

  func body(_ source: Source, piece: UInt32) -> [UInt32] {
    guard !Task.isCancelled else { return [] }
    return Array(source.native.body(piece))
  }

  func fits(_ source: Source, moving: UInt32, target: UInt32) -> Fits {
    guard !Task.isCancelled else { return Fits(values: []) }
    return Fits(values: Array(source.native.fits(moving, target)))
  }

  func fitting(_ source: Source, piece: UInt32, candidates: [LibraryPart]) -> [CompatibleParts.Match] {
    guard !Task.isCancelled else { return [] }
    let metadata = Dictionary(candidates.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    var choices = bmapp.StringList()
    for item in candidates { choices.push_back(std.string(item.id)) }
    return source.native.fittingParts(piece, choices, 30).compactMap { item in
      guard let ready = metadata[String(item.name)] else { return nil }
      return CompatibleParts.Match(part: ready, x: item.contact.x, y: item.contact.y, z: item.contact.z)
    }
  }

  func change(_ source: Source, fixed: UInt32, moving: UInt32, degrees: Double, collision: Bool) -> JointChange? {
    guard !Task.isCancelled else { return nil }
    let response = source.native.changeJoint(fixed, moving, degrees, collision)
    return JointChange(pieces: Array(response.pieces), pivot: response.pivot,
                       pose: response.pose, error: String(response.error))
  }
}

extension AssemblyInspectionWorker {
  /// A part builders attach to the target, at their pose.
  struct Suggestion: Identifiable, @unchecked Sendable {
    let part: LibraryPart
    let colour: Int32
    let pose: bmapp.PartPose
    let models, total: Int
    let joint: String
    let why: String
    var id: String { "habit:" + part.id }
  }

  func suggestions(_ source: Source, piece: UInt32, limit: Int = 8) -> [Suggestion] {
    guard !Task.isCancelled else { return [] }
    return source.native.habitFits(piece, limit).map { fit in
      Suggestion(part: LibraryPart(id: String(fit.name), name: displayName(String(fit.description))), colour: Int32(fit.color),
                 pose: fit.pose, models: Int(fit.models), total: Int(fit.total), joint: String(fit.joint),
                 why: String(bmapp.habitWhy(fit)))
    }
  }
}
