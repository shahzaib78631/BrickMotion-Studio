// The window's right pane: Selection (several pieces, or the model when none), Part (one piece)
// and Submodel (the model being edited, or the submodel of the selected use).
import AppKit
import BMApp
import Observation
import SwiftUI

enum InspectorTab: String, CaseIterable { case selection, part, submodel, camera }

/// The Part tab's state: the one selected piece, and its placement as fields.
@MainActor @Observable final class PartInspectorModel {
  @ObservationIgnored let model: DocumentModel
  init(model: DocumentModel) { self.model = model }

  var info: bmapp.PieceInfo? { model.snapshot.selection.count == 1 ? model.snapshot.selected.first : nil }
  var position: bmapp.Vec3? { info?.position }

  /// Moves the piece so its position along `axis` (0 X, 1 Y, 2 Z) is `value`, in LDU.
  func set(axis: Int, to value: Double) {
    guard let info, let p = position else { return }
    let now = axis == 0 ? p.x : axis == 1 ? p.y : p.z
    guard value.isFinite, abs(value - now) > 1e-9 else { return }
    var d = bmapp.Vec3()
    if axis == 0 { d.x = value - now } else if axis == 1 { d.y = value - now } else { d.z = value - now }
    let piece = info.piece
    model.context.perform { $0.move(ViewportView.list([piece]), d, false) }
  }
}

struct Inspector: View {
  @Bindable var model: DocumentModel

  var body: some View {
    VStack(spacing: 0) {
      Picker("Inspector", selection: $model.inspectorTab) {
        Text("Selection").tag(InspectorTab.selection)
        Text("Part").tag(InspectorTab.part)
        Text("Submodel").tag(InspectorTab.submodel)
        if model.animation.visible { Text("Camera").tag(InspectorTab.camera) }
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      Divider()
      if let placement = model.viewport?.placement, placement.active,
         placement.state == .Blocked || placement.state == .Unavailable {
        Label {
          Text(placement.reason).font(.caption).frame(maxWidth: .infinity, alignment: .leading)
        } icon: {
          Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
        }
        .padding(10)
        .frame(maxWidth: .infinity)
        .background(.primary.opacity(0.05))
        Divider()
      }
      switch model.inspectorTab {
      case .selection: SelectionTab(model: model)
      case .part: PartTab(model: model, part: PartInspectorModel(model: model))
      case .submodel: SubmodelTab(model: model)
      case .camera: CameraMonitor(model: model, workspace: model.animation)
      }
    }
  }
}

private struct CameraMonitor: View {
  let model: DocumentModel
  @Bindable var workspace: AnimationWorkspace

  var body: some View {
    if let camera = model.viewport?.presentation {
      Form {
        Section("Preview") {
          Toggle("Director Camera", isOn: $workspace.director)
          LabeledContent("Projection", value: camera.orthographic ? "Orthographic" : "Perspective")
          LabeledContent("View", value: camera.name)
        }
        Section("Lens") {
          LabeledContent("Vertical Angle", value: angle(camera.fieldOfView))
          LabeledContent("Distance", value: number(camera.distance) + " LDU")
        }
        Section("Orientation") {
          LabeledContent("Azimuth", value: angle(camera.yaw * 180 / .pi))
          LabeledContent("Elevation", value: angle(camera.pitch * 180 / .pi))
        }
        Section("Target · LDU") {
          LabeledContent("X", value: number(camera.target.x))
          LabeledContent("Y", value: number(camera.target.y))
          LabeledContent("Z", value: number(camera.target.z))
        }
      }
      .formStyle(.grouped)
      .monospacedDigit()
    }
  }

  private func number(_ value: Double) -> String { value.formatted(.number.precision(.fractionLength(0...1))) }
  private func angle(_ value: Double) -> String { number(value) + "°" }
}

// MARK: Shared rows

/// The colour of the selection, with the swatches in a popover.
private struct ColorRow: View {
  let model: DocumentModel
  @State private var open = false

  var body: some View {
    let colors = Set(model.snapshot.selected.map { $0.color })
    let one = colors.count == 1 ? colors.first.flatMap { model.colors[$0] } : nil
    LabeledContent("Colour") {
      Button { open = true } label: {
        HStack(spacing: 6) {
          if let one { Swatch(info: one, size: 16) } else { Image(systemName: "circle.lefthalf.filled") }
          Text(one.map { String($0.name) } ?? "Mixed")
          Image(systemName: "chevron.up.chevron.down").font(.caption2).foregroundStyle(.secondary)
        }
      }
      .buttonStyle(.borderless)
      .popover(isPresented: $open, arrowEdge: .leading) {
        ColorSwatches(swatches: ColorSwatchesModel(model: model))
      }
      .accessibilityLabel("Colour, \(one.map { String($0.name) } ?? "mixed")")
    }
  }
}

/// The step the selection is in; choosing one moves it there.
private struct StepPicker: View {
  let model: DocumentModel

  var body: some View {
    let steps = Set(model.snapshot.selected.map { Int($0.step) })
    let pieces = Array(model.snapshot.selection)
    LabeledContent("Step") {
      Menu(steps.count == 1 ? "Step \(steps.first! + 1)" : "Mixed") {
        ForEach(model.steps, id: \.index) { step in
          Button("Step \(step.index + 1)\(step.title.empty() ? "" : " – \(String(step.title))")") {
            model.context.perform { $0.moveToStep(ViewportView.list(pieces), Int(step.index)) }
          }
        }
      }
      .fixedSize()
    }
  }
}

@MainActor private func run(_ id: String, _ model: DocumentModel) {
  Registry.command(id)?.run(model.context)
}

@MainActor private func enabled(_ id: String, _ model: DocumentModel) -> Bool {
  _ = model.snapshot.version
  return Registry.command(id)?.enabled(model.context) ?? false
}

// MARK: Selection

private struct SelectionTab: View {
  let model: DocumentModel

  var body: some View {
    let snap = model.snapshot
    if snap.selection.isEmpty {
      ModelOverview(model: model)
    } else {
      Form {
        Section {
          LabeledContent("Selected", value: "\(snap.selection.count) \(snap.selection.count == 1 ? "piece" : "pieces")")
          let counts = partCounts(snap)
          ForEach(counts.prefix(8), id: \.0) { name, n in
            LabeledContent(displayName(name)) { Text("× \(n)").monospacedDigit() }
              .font(.callout)
          }
          if counts.count > 8 || snap.selection.count > snap.selected.count {
            Text("and more").font(.caption).foregroundStyle(.secondary)
          }
        }
        Section {
          ColorRow(model: model)
          StepPicker(model: model)
          GroupRow(model: model)
        }
        Section {
          Button("Make Submodel…") { run("object.makeSubmodel", model) }.disabled(!enabled("object.makeSubmodel", model))
          if snap.selection.count == 2 {
            Button("Ways to Fit…") { run("object.waysToFit", model) }.disabled(!enabled("object.waysToFit", model))
              .overlay(alignment: .trailing) {
                if model.assemblyReview.fitting { ProgressView().controlSize(.mini).accessibilityLabel("Finding fits") }
              }
          }
          Menu("Move to Model") {
            ForEach(Registry.modelNames(model.context), id: \.self) { name in
              Button(displayName(name)) {
                let pieces = Array(model.snapshot.selection)
                model.context.perform { $0.moveToModel(ViewportView.list(pieces), std.string(name)) }
              }
            }
          }
          .disabled(Registry.modelNames(model.context).isEmpty)
          Button("Extract") { run("object.extract", model) }.disabled(!enabled("object.extract", model))
          HStack {
            Button("Duplicate") { model.viewport?.duplicatePieces(nil) }
            Button("Delete", role: .destructive) { model.viewport?.deletePieces(nil) }
          }
        }
      }
      .formStyle(.grouped)
    }
  }
}

/// The selection's distinct parts with how many of each, most first.
@MainActor private func partCounts(_ snap: bmapp.Snapshot) -> [(String, Int)] {
  var counts: [String: Int] = [:]
  for info in snap.selected {
    let name = String(info.description.empty() ? info.part : info.description)
    counts[name, default: 0] += 1
  }
  return counts.sorted { a, b in a.value != b.value ? a.value > b.value : a.key < b.key }.map { ($0.key, $0.value) }
}

private struct ModelOverview: View {
  let model: DocumentModel

  var body: some View {
    let name = model.snapshot.focus.empty() ? String(model.document.session.title()) : String(model.snapshot.focus)
    let submodels = Set(model.outline.flatMap { all($0) }.filter { !$0.row.def.empty() }.map { String($0.row.def) }).count
    Form {
      Section {
        LabeledContent("Model", value: displayName(name))
        LabeledContent("Pieces", value: "\(model.snapshot.pieces)")
        LabeledContent("Steps", value: "\(model.steps.count)")
        LabeledContent("Submodels", value: "\(submodels)")
      } footer: {
        Text("Select pieces to edit them here.").foregroundStyle(.secondary)
      }
    }
    .formStyle(.grouped)
  }

  private func all(_ n: OutlineNode) -> [OutlineNode] { [n] + (n.children ?? []).flatMap(all) }
}

// MARK: Part

private struct PartTab: View {
  let model: DocumentModel
  let part: PartInspectorModel

  var body: some View {
    if let info = part.info {
      Form {
        Section {
          HStack(spacing: 12) {
            PartPreviewImage(part: info.inlinePart ? nil : String(info.part), color: info.color)
              .frame(width: 54, height: 54)
              .clipShape(.rect(cornerRadius: 9))
            VStack(alignment: .leading, spacing: 2) {
              Text(displayName(String(info.description.empty() ? info.part : info.description))).font(.headline).lineLimit(2)
              Text(String(info.part)).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
          }
          ColorRow(model: model)
          StepPicker(model: model)
          GroupRow(model: model)
        }
        let path = String(info.submodelPath).split(separator: "/").map(String.init)
        if !path.isEmpty {
          Section("In") {
            ForEach(Array(path.enumerated()), id: \.offset) { i, name in
              LabeledContent(displayName(name)) {
                Button("Open") { model.context.refocus(model.focusPath + Array(path.prefix(i + 1))) }
              }
            }
            if info.inSharedSubmodel {
              VStack(alignment: .leading, spacing: 6) {
                Label("This submodel is used more than once: editing it changes every use.", systemImage: "square.on.square")
                  .font(.callout)
                  .foregroundStyle(.secondary)
                Button("Make Unique") { model.viewport?.makeUnique(nil) }
              }
            }
          }
        }
        Section("Placement") {
          let p = info.position
          AxisField(label: "X", value: p.x) { part.set(axis: 0, to: $0) }
          AxisField(label: "Y", value: p.y) { part.set(axis: 1, to: $0) }
          AxisField(label: "Z", value: p.z) { part.set(axis: 2, to: $0) }
          LabeledContent("Turn") {
            HStack {
              Button { model.viewport?.rotatePiecesBack(nil) } label: { Image(systemName: "rotate.left") }
                .help("Turn 90° counterclockwise")
              Button { model.viewport?.rotatePieces(nil) } label: { Image(systemName: "rotate.right") }
                .help("Turn 90° clockwise")
            }
          }
        }
        PartConnections(model: model, piece: info.piece)
        Section("Build") {
          ArrivalDirectionRow(model: model, piece: info.piece)
          Button("Find Compatible Parts…") { CompatiblePartsSheet.show(model: model, piece: info.piece) }
        }
        Section {
          Button("Replace Part…") { model.viewport?.replacePart(nil) }
        }
      }
      .formStyle(.grouped)
    } else {
      ContentUnavailableView("No Part", systemImage: "cube",
                             description: Text(model.snapshot.selection.isEmpty ? "Select a piece to see it here." : "Select one piece to see it here."))
    }
  }
}

/// A number field in LDU that commits on Return or when it loses the keyboard.
private struct AxisField: View {
  let label: String
  let value: Double
  let commit: (Double) -> Void
  @State private var text = ""
  @FocusState private var focused: Bool

  var body: some View {
    LabeledContent(label) {
      HStack(spacing: 4) {
        TextField(label, text: $text)
          .labelsHidden()
          .multilineTextAlignment(.trailing)
          .monospacedDigit()
          .focused($focused)
          .frame(width: 90)
          .onSubmit(send)
          .onChange(of: focused) { if !focused { send() } }
        Text("LDU").font(.caption).foregroundStyle(.secondary)
      }
    }
    .onAppear { text = Self.format(value) }
    .onChange(of: value) { if !focused { text = Self.format(value) } }
  }

  private func send() {
    if let v = Double(text.trimmingCharacters(in: .whitespaces)) { commit(v) } else { text = Self.format(value) }
  }

  static func format(_ v: Double) -> String { v.formatted(.number.precision(.fractionLength(0...2)).grouping(.never)) }
}

// MARK: Submodel

private struct SubmodelTab: View {
  let model: DocumentModel
  @State private var name = ""

  /// The submodel shown: the one of the selected use, else the one being edited.
  private var def: String {
    let firsts = Set(model.snapshot.selected.map { String($0.submodelPath).split(separator: "/").first.map(String.init) ?? "" })
    if firsts.count == 1, let f = firsts.first, !f.isEmpty { return f }
    return String(model.snapshot.focus)
  }

  var body: some View {
    let def = self.def
    let rows = model.outline.flatMap { all($0) }.filter { String($0.row.def) == def }
    if def.isEmpty {
      ContentUnavailableView("Whole Model", systemImage: "cube.fill",
                             description: Text("Select a submodel's pieces, or open one, to see it here."))
    } else {
      Form {
        Section {
          TextField("Name", text: $name)
            .onSubmit {
              if let row = rows.first { model.rename(row: row, to: name) }
            }
          LabeledContent("Uses", value: "\(rows.first.map { Int($0.row.uses) } ?? 0)")
          LabeledContent("Pieces", value: "\(rows.first.map { Int($0.row.pieces) } ?? 0)")
          if def == String(model.snapshot.focus) { LabeledContent("Steps", value: "\(model.steps.count)") }
        }
        Section {
          Button("Open") { if let row = rows.first { model.open(row: row) } }
            .disabled(def == String(model.snapshot.focus) || rows.isEmpty)
          Button("Select Uses") { model.select(rows: Set(rows.map(\.id))) }
            .disabled(rows.isEmpty || def == String(model.snapshot.focus))
        }
      }
      .formStyle(.grouped)
      .onAppear { name = def }
      .onChange(of: def) { name = def }
    }
  }

  private func all(_ n: OutlineNode) -> [OutlineNode] { [n] + (n.children ?? []).flatMap(all) }
}
