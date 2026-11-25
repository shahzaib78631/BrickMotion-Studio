// Step → Seat Loose Pieces: the pieces the file places a little off what holds them (bm plan
// --correct), each set exactly onto its connector in one undo step. A piece whose seat would
// cross a part it does not cross already is listed but left unchecked.
import AppKit
import BMApp
import SwiftUI

@MainActor struct LoosePiecesSheet: View {
  let model: DocumentModel
  let source: AssemblyInspectionWorker.Source
  let seat: ([bmapp.LoosePiece]) -> Void
  let reveal: ([UInt32]) -> Void
  let close: () -> Void
  private let worker = AssemblyInspectionWorker()
  @State private var found: AssemblyInspectionWorker.Loose?
  @State private var chosen: Set<UInt32> = []

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 4) {
        Text("Seat Loose Pieces").font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
        Text("Pieces placed a little off their studs, pins or clips, set exactly in place.")
          .foregroundStyle(.secondary)
      }
      .padding(21)
      Divider()
      Group {
        if let found {
          results(found)
        } else {
          ProgressView("Looking for loose pieces…").frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
      Divider()
      HStack {
        if let found, !found.pieces.isEmpty {
          Text("\(chosen.count) of \(found.pieces.count) selected").font(.callout).foregroundStyle(.secondary)
            .monospacedDigit()
        }
        Spacer()
        Button("Cancel", action: close).keyboardShortcut(.cancelAction)
        Button(chosen.count == 1 ? "Seat Piece" : "Seat \(chosen.count) Pieces") {
          seat(found?.pieces.filter { chosen.contains($0.piece) } ?? [])
        }
        .keyboardShortcut(.defaultAction)
        .disabled(chosen.isEmpty)
      }
      .padding(.horizontal, 21)
      .padding(.vertical, 13)
    }
    .frame(width: 500, height: 440)
    .task {
      let result = await worker.loosePieces(source)
      guard !Task.isCancelled else { return }
      found = result
      chosen = Set(result.pieces.filter(\.safe).map(\.piece))
      // A safe piece seated onto one that is not stays as it is too.
      for row in result.pieces where !chosen.contains(row.piece) {
        for dependent in result.pieces where dependent.onto == row.piece { uncheck(dependent.piece, result.pieces) }
      }
    }
  }

  @ViewBuilder private func results(_ found: AssemblyInspectionWorker.Loose) -> some View {
    if !found.error.isEmpty {
      ContentUnavailableView("Couldn’t Check the Model", systemImage: "exclamationmark.triangle",
                             description: Text(found.error))
    } else if found.pieces.isEmpty {
      ContentUnavailableView("Every Piece Is Seated", systemImage: "checkmark.circle",
                             description: Text("No piece sits off the connector that holds it."))
    } else {
      let listed = Dictionary(found.pieces.map { ($0.piece, $0) }, uniquingKeysWith: { first, _ in first })
      List(found.pieces, id: \.piece) { row in
        let waiting = waitingOn(row, listed)
        HStack(spacing: 10) {
          Toggle(isOn: Binding(get: { chosen.contains(row.piece) },
                               set: { on in if on { chosen.insert(row.piece) } else { uncheck(row.piece, found.pieces) } })) {
            EmptyView()
          }
          .toggleStyle(.checkbox)
          .labelsHidden()
          .disabled(waiting != nil)
          .accessibilityLabel("Seat \(name(row.piece))")
          VStack(alignment: .leading, spacing: 2) {
            Text(name(row.piece)).font(.callout.weight(.medium)).lineLimit(1)
              .foregroundStyle(waiting == nil ? Color.primary : Color.secondary)
            Text(waiting.map { "Seated onto \(name($0)): check it first" } ?? detail(row)).font(.caption)
              .foregroundStyle(row.safe || waiting != nil ? Color.secondary : Color.orange)
              .lineLimit(2)
          }
          Spacer(minLength: 6)
          Button {
            reveal([row.piece, row.onto])
          } label: {
            Image(systemName: "viewfinder")
          }
          .buttonStyle(.borderless)
          .help("Select and frame it with what holds it")
          .accessibilityLabel("Show \(name(row.piece))")
        }
        .padding(.vertical, 3)
      }
      .listStyle(.inset)
    }
  }

  /// A piece's seat is worked out with what holds it already seated: while a listed piece it
  /// rests on (at any depth) is left as it is, it cannot be seated. That piece, or nil.
  private func waitingOn(_ row: bmapp.LoosePiece, _ listed: [UInt32: bmapp.LoosePiece]) -> UInt32? {
    var seen: Set<UInt32> = [row.piece]
    var holder = row.onto
    while let next = listed[holder], seen.insert(holder).inserted {
      if !chosen.contains(holder) { return holder }
      holder = next.onto
    }
    return nil
  }

  /// Leaves a piece as it is, and every listed piece seated onto it.
  private func uncheck(_ piece: UInt32, _ rows: [bmapp.LoosePiece]) {
    var pending = [piece], seen: Set<UInt32> = []
    while let next = pending.popLast() {
      guard seen.insert(next).inserted else { continue }
      chosen.remove(next)
      pending += rows.filter { $0.onto == next }.map(\.piece)
    }
  }

  /// "Blue Brick 2 x 4": the colour tells apart pieces of one part.
  private func name(_ piece: UInt32) -> String {
    let session = model.document.session
    let match = session.partAt(piece)
    let part = displayName(String(match.description).isEmpty ? String(match.name) : String(match.description))
    guard let colour = model.colors[Int32(session.partColor(piece))] else { return part }
    return "\(String(colour.name)) \(part)"
  }

  private func detail(_ row: bmapp.LoosePiece) -> String {
    var parts: [String] = []
    if row.offset >= 0.05 { parts.append("\(row.offset.formatted(.number.precision(.fractionLength(1)))) LDU off") }
    if row.angle >= 0.05 { parts.append("turned \(row.angle.formatted(.number.precision(.fractionLength(1))))°") }
    parts.append("on \(name(row.onto))")
    var text = parts.joined(separator: " · ")
    if !row.safe { text += row.note.empty() ? " · would cross another part" : " · \(String(row.note))" }
    return text
  }

  static func show(_ context: CommandContext) {
    guard let model = context.model, let window = context.window, window.attachedSheet == nil,
          let native = bmapp.AssemblyInspection.capture(model.document.session) else { return }
    let source = AssemblyInspectionWorker.Source(native)
    let session = model.document.session
    let version = session.version(), generation = session.generation()
    let sheet = NSWindow()
    let close: () -> Void = { [weak window, weak sheet] in if let sheet { window?.endSheet(sheet) } }
    let view = LoosePiecesSheet(model: model, source: source, seat: { rows in
      close()
      var moves = bmapp.PieceMoves()
      for row in rows {
        var move = bmapp.PieceMove()
        move.piece = row.piece
        move.pose = row.pose
        moves.push_back(move)
      }
      context.perform { $0.seatPieces(moves, generation, version) }
    }, reveal: { [weak model] ids in
      guard let model else { return }
      close()
      guard session.generation() == generation, session.version() == version else { return }
      model.animation.rest()
      session.show(ViewportView.list(ids))
      model.select(pieces: ids)
      model.viewport?.frameSelection(nil)
    }, close: close)
    sheet.contentViewController = NSHostingController(rootView: view)
    window.beginSheet(sheet)
  }
}
