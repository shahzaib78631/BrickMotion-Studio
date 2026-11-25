import BMApp
import SwiftUI

struct MotionWorkspace: View {
  let model: DocumentModel
  @Bindable var workspace: AnimationWorkspace
  @State private var scope = Scope.project
  @State private var editing = false

  private enum Scope: String, CaseIterable { case project = "Project", step = "Step", part = "Part" }

  private var step: Int { workspace.currentStep ?? model.selectedStep ?? 0 }
  private var selected: [UInt32] { Array(model.snapshot.selection) }
  private var nativeScope: bmapp.MotionScope {
    switch scope {
    case .project: .Project
    case .step: .Step
    case .part: .Parts
    }
  }

  var body: some View {
    ScrollView {
      HStack(alignment: .top, spacing: 22) {
        VStack(alignment: .leading, spacing: 10) {
          Text("Build Motion").font(.headline)
          Picker("Motion scope", selection: $scope) {
            ForEach(Scope.allCases, id: \.self) { option in
              Text(option.rawValue).tag(option)
            }
          }
          .pickerStyle(.segmented)
          .labelsHidden()
          Text(scopeName).font(.callout).foregroundStyle(.secondary).lineLimit(2)
          HStack {
            Button("Edit Motion…") { editing = true }
              .disabled(!available)
              .popover(isPresented: $editing, arrowEdge: .top) {
                MotionEditor(model: model, scope: nativeScope, step: step, pieces: selected, title: scopeName)
              }
            Button {
              if scope == .project {
                workspace.viewport?.viewport.playRange(0, 0)
                workspace.viewport?.changed()
                workspace.update()
              } else {
                workspace.play(step: step)
              }
            } label: {
              Label("Preview", systemImage: "play")
            }
            .disabled(!available || !workspace.ready)
          }
        }
        .frame(width: 250, alignment: .leading)
        Divider()
        if available {
          settingsSummary
        } else {
          Text(scope == .part ? "Select one part in the viewport or Parts lane." : "Choose a step in the Build timeline.")
            .font(.callout).foregroundStyle(.secondary)
        }
        Spacer(minLength: 0)
      }
      .padding(14)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private var available: Bool {
    switch scope {
    case .project: true
    case .step: model.steps.indices.contains(step)
    case .part: selected.count == 1
    }
  }

  private var scopeName: String {
    switch scope {
    case .project: String(model.document.session.title())
    case .step: model.steps.indices.contains(step) ? "Step \(step + 1)" : "No step selected"
    case .part: selected.count == 1 ? displayName(String(model.document.session.partAt(selected[0]).description)) : "No part selected"
    }
  }

  private var settingsSummary: some View {
    let session = model.document.session
    let local = session.motionFields(nativeScope, step, ViewportView.list(selected))
    let effective = MotionEditor.effective(model: model, scope: nativeScope, step: step, fields: local)
    return VStack(alignment: .leading, spacing: 12) {
      Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 5) {
        GridRow {
          Text("Duration").foregroundStyle(.secondary)
          Text(MotionEditor.multiplier(effective.time)).monospacedDigit()
          Text("Easing").foregroundStyle(.secondary)
          Text(MotionEditor.easeName(effective.ease))
        }
      }
      .font(.callout)
      FlightTiming(fields: effective)
    }
    .frame(maxWidth: 480, alignment: .leading)
    .padding(.vertical, 3)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Effective motion settings")
  }
}

private struct FlightTiming: View {
  let fields: bmapp.MotionFields

  var body: some View {
    let phases = bmapp.flightPhases(fields)
    let hover = phases.hover, travel = phases.travel
    VStack(alignment: .leading, spacing: 7) {
      GeometryReader { geometry in
        HStack(spacing: 0) {
          Rectangle().fill(Color.accentColor.opacity(0.60)).frame(width: geometry.size.width * travel)
          Rectangle().fill(.secondary.opacity(0.27)).frame(width: geometry.size.width * hover)
          Rectangle().fill(Color.accentColor)
        }
        .clipShape(.capsule)
      }
      .frame(height: 9)
      HStack(spacing: 12) {
        phase("Travel", travel, Color.accentColor.opacity(0.60))
        phase("Hover", hover, .secondary.opacity(0.45))
        phase("Landing", fields.landing, .accentColor)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Flight timing")
    .accessibilityValue("Travel \(MotionEditor.percent(travel)), hover \(MotionEditor.percent(hover)), landing \(MotionEditor.percent(fields.landing))")
  }

  private func phase(_ name: String, _ value: Double, _ tint: Color) -> some View {
    HStack(spacing: 4) {
      Circle().fill(tint).frame(width: 5, height: 5)
      Text(name).foregroundStyle(.secondary)
      Text(MotionEditor.percent(value)).monospacedDigit()
    }
    .font(.caption)
    .fixedSize()
  }
}

struct MotionEditor: View {
  let model: DocumentModel
  let scope: bmapp.MotionScope
  let step: Int
  let pieces: [UInt32]
  let title: String
  let close: (() -> Void)?
  @State private var fields: bmapp.MotionFields
  @Environment(\.dismiss) private var dismiss

  init(model: DocumentModel, scope: bmapp.MotionScope, step: Int, pieces: [UInt32], title: String, close: (() -> Void)? = nil) {
    self.model = model
    self.scope = scope
    self.step = step
    self.pieces = pieces
    self.title = title
    self.close = close
    _fields = State(initialValue: model.document.session.motionFields(scope, step, ViewportView.list(pieces)))
  }

  private var inherited: bmapp.MotionFields {
    Self.effective(model: model, scope: scope, step: step, fields: .init())
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        VStack(alignment: .leading, spacing: 3) {
          Text("Build Motion").font(.headline)
          Text(title).font(.callout).foregroundStyle(.secondary).lineLimit(1)
        }
        Spacer()
        Menu("Presets") {
          Button("Balanced") { fields = .init(time: 1, landing: 0.25, hover: 0.08, ease: 0) }
          Button("Precise Seating") { fields = .init(time: 1.4, landing: 0.45, hover: 0.12, ease: 2) }
          Button("Fast Assembly") { fields = .init(time: 0.7, landing: 0.2, hover: 0, ease: 1) }
          Divider()
          Button("Reset All") { fields = .init() }
        }
        .fixedSize()
      }
      Divider()
      valueRow("Duration", value: $fields.time, inherited: inherited.time, range: 0.25...4, format: Self.multiplier)
      valueRow("Landing", value: $fields.landing, inherited: inherited.landing, range: 0.1...0.7, format: Self.percent)
      valueRow("Hover", value: $fields.hover, inherited: inherited.hover, range: 0...0.4, format: Self.percent)
      Picker("Easing", selection: $fields.ease) {
        Text("Inherit · \(Self.easeName(inherited.ease))").tag(Int32(-1))
        ForEach(0..<4) { index in Text(Self.easeName(Int32(index))).tag(Int32(index)) }
      }
      FlightTiming(fields: Self.effective(model: model, scope: scope, step: step, fields: fields))
        .padding(.top, 2)
      Divider()
      HStack {
        Spacer()
        Button("Cancel", action: finish).keyboardShortcut(.cancelAction)
        Button("Apply") {
          let applied = model.context.perform { $0.setMotionFields(scope, step, ViewportView.list(pieces), fields) }
          if applied { finish() }
        }
        .keyboardShortcut(.defaultAction)
      }
    }
    .padding(14)
    .frame(width: 325)
  }

  private func finish() {
    if let close { close() } else { dismiss() }
  }

  private func valueRow(_ name: String, value: Binding<Double>, inherited: Double, range: ClosedRange<Double>,
                        format: @escaping (Double) -> String) -> some View {
    HStack(spacing: 8) {
      Text(name).frame(width: 51, alignment: .leading)
      Slider(value: Binding(get: { value.wrappedValue >= 0 ? value.wrappedValue : inherited },
                            set: { value.wrappedValue = $0 }), in: range, step: 0.01)
        .accessibilityLabel(name)
      Text(format(value.wrappedValue >= 0 ? value.wrappedValue : inherited))
        .monospacedDigit().frame(width: 46, alignment: .trailing)
        .foregroundStyle(value.wrappedValue >= 0 ? .primary : .secondary)
      Button { value.wrappedValue = -1 } label: { Image(systemName: "arrow.uturn.backward") }
        .buttonStyle(.borderless)
        .disabled(value.wrappedValue < 0)
        .help("Reset \(name.lowercased()) to inherited value")
        .accessibilityLabel("Reset \(name.lowercased())")
    }
    .font(.callout)
  }

  static func effective(model: DocumentModel, scope: bmapp.MotionScope, step: Int, fields: bmapp.MotionFields) -> bmapp.MotionFields {
    bmapp.effectiveMotion(model.document.session, scope, step, fields)
  }

  static func easeName(_ value: Int32) -> String {
    switch value {
    case 1: "Gentle"
    case 2: "Soft"
    case 3: "Linear"
    default: "Smooth"
    }
  }

  static func multiplier(_ value: Double) -> String { value.formatted(.number.precision(.fractionLength(0...2))) + "×" }
  static func percent(_ value: Double) -> String { value.formatted(.percent.precision(.fractionLength(0))) }
}
