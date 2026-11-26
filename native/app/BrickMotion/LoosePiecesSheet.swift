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
      chosen = Set(bmapp.initialLooseChoice(nativeRows(result.pieces)))
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
      let rows = nativeRows(found.pieces)
      let selected = nativeChosen()
      List(found.pieces, id: \.piece) { row in
        let waitingRaw = bmapp.looseWaitingOn(rows, row.piece, selected)
        let waiting: UInt32? = waitingRaw == UInt32.max ? nil : waitingRaw
        HStack(spacing: 10) {
          Toggle(isOn: Binding(get: { chosen.contains(row.piece) },
                               set: { on in
                                 if on { chosen.insert(row.piece) }
                                 else { chosen = Set(bmapp.looseUncheck(rows, row.piece, nativeChosen())) }
                               })) {
            EmptyView()
          }
          .toggleStyle(.checkbox)
          .labelsHidden()
          .disabled(waiting != nil)
          .accessibilityLabel("Seat \(name(row.piece))")
          VStack(alignment: .leading, spacing: 2) {
            Text(name(row.piece)).font(.callout.weight(.medium)).lineLimit(1)
              .foregroundStyle(waiting == nil ? Color.primary : Color.secondary)
            Text(waiting.map { "Seated onto \(name($0)): check it first" } ?? String(bmapp.looseDetail(row, std.string(name(row.onto))))).font(.caption)
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

  private func nativeRows(_ rows: [bmapp.LoosePiece]) -> bmapp.LoosePieceList {
    var list = bmapp.LoosePieceList()
    for row in rows { list.push_back(row) }
    return list
  }

  private func nativeChosen() -> bmapp.PieceList {
    var list = bmapp.PieceList()
    for piece in chosen { list.push_back(piece) }
    return list
  }

  /// "Blue Brick 2 x 4": the colour tells apart pieces of one part.
  private func name(_ piece: UInt32) -> String {
    let session = model.document.session
    let match = session.partAt(piece)
    let part = displayName(String(match.description).isEmpty ? String(match.name) : String(match.description))
    guard let colour = model.colors[Int32(session.partColor(piece))] else { return part }
    return "\(String(colour.name)) \(part)"
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
