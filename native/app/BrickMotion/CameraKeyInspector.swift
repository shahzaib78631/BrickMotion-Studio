// The Camera inspector's key and move panels (the web's CameraInspector): the selected camera
// key (where the camera is, what it looks at, its lens) or the move from it to the next key (how
// the camera gets there). A typed value is one undo step; a slider's whole drag is one step.
import SwiftUI
import BMApp

struct CameraSelectionInspector: View {
  let model: DocumentModel
  let workspace: AnimationWorkspace
  let selection: CameraSelection

  var body: some View {
    // read every edit: the panels show the track as it is now
    let _ = model.snapshot.version
    let keys = model.cameraKeys(selection.clock)
    if let id = selection.keyId, let key = keys.first(where: { String($0.id) == id }) {
      CameraKeyPanel(model: model, workspace: workspace, clock: selection.clock, key: key)
    } else if let from = selection.moveFrom,
              let move = Array(model.document.session.cameraMoves(selection.clock)).first(where: { String($0.from) == from }) {
      CameraMovePanel(model: model, clock: selection.clock, move: move, keys: keys)
    }
  }
}

/// A key: what it looks at, from where, and its lens.
private struct CameraKeyPanel: View {
  let model: DocumentModel
  let workspace: AnimationWorkspace
  let clock: bmapp.CameraClock
  let key: bmapp.CameraTrackKey

  private var aim: CameraAim { CameraAim(rawValue: String(key.target)) ?? .point }
  private var standsStill: Bool { aim == .point && !key.fitted }

  var body: some View {
    Section {
      Picker("Look At", selection: Binding(get: { aim }, set: { CameraKeyMenu.aim(model: model, clock: clock, key: key, at: $0) })) {
        ForEach(CameraAim.allCases, id: \.self) { Text($0.label).tag($0) }
      }
      if standsStill {
        CameraNumberRow("Camera X", value: key.eye.x, range: -100_000...100_000, unit: "LDU") { x, _ in set { $0.eye.x = x } }
        CameraNumberRow("Camera Y", value: key.eye.y, range: -100_000...100_000, unit: "LDU") { y, _ in set { $0.eye.y = y } }
        CameraNumberRow("Camera Z", value: key.eye.z, range: -100_000...100_000, unit: "LDU") { z, _ in set { $0.eye.z = z } }
      }
      CameraSliderRow("Angle Around", value: key.azimuth, range: -360...360, step: 1, format: degrees) { value, more in
        set(more) { $0.azimuth = value }
      }
      CameraSliderRow("Height", value: key.elevation, range: -85...89, step: 1, format: degrees) { value, more in
        set(more) { $0.elevation = value }
      }
      Toggle("Fit Distance to What It Frames", isOn: Binding(get: { key.fitted }, set: { fit in
        set { $0.fitted = fit; if fit { $0.margin = 1.15 } else { $0.distance = max(0.5, $0.distance) } }
      }))
      if key.fitted {
        CameraSliderRow("Framing Margin", value: key.margin, range: 0.6...3, step: 0.01, format: { "\($0.formatted(.number.precision(.fractionLength(2))))×" }) { value, more in
          set(more) { $0.margin = value }
        }
      } else {
        CameraNumberRow("Distance", value: key.distance, range: 0.5...5000, unit: "studs") { value, _ in set { $0.distance = value } }
      }
      CameraSliderRow("Dutch Roll", value: key.roll, range: -45...45, step: 1, format: degrees) { value, more in
        set(more) { $0.roll = value }
      }
    } header: {
      Text("Camera Key · \(timecode(key.seconds))\(key.user ? "" : " · Automatic")")
    } footer: {
      if aim == .point && key.fitted {
        Text("Turn off Fit Distance to type where the camera stands.").font(.caption).foregroundStyle(.secondary)
      }
    }
    Section("Lens") {
      CameraNumberRow("Focal Length", value: key.lensMm, range: 12...300, unit: "mm", step: 1) { value, _ in set { $0.lensMm = value } }
      Toggle("Focus on What It Looks At", isOn: Binding(get: { key.focusTarget }, set: { on in set { $0.focusTarget = on } }))
      if !key.focusTarget {
        CameraSliderRow("Focus Depth", value: key.focus, range: 0...1, step: 0.01, format: percent) { value, more in
          set(more) { $0.focus = value }
        }
      }
      CameraSliderRow("Background Blur", value: key.blur, range: 0...1, step: 0.01, format: percent) { value, more in
        set(more) { $0.blur = value }
      }
    }
    Section {
      HStack {
        Button("Update from View") { CameraKeyMenu.updateFromView(model: model, clock: clock, id: String(key.id)) }
          .help("This key films the viewport's view as it is now")
        Button("Go to Key") { CameraClockInfo.of(clock, model: model, workspace: workspace).seek(key.seconds) }
        Spacer()
        Button("Delete Key", role: .destructive) { CameraKeyMenu.delete(model: model, clock: clock, id: String(key.id)) }
      }
    }
  }

  /// One change to the key's fields; `continuing` grows the step of the drag it belongs to.
  private func set(_ continuing: Bool = false, _ change: (inout bmapp.CameraTrackKey) -> Void) {
    var next = key
    change(&next)
    model.context.perform { $0.setCameraKey(clock, next, continuing) }
  }
}

/// The move from one key to the next: its preset and how it travels.
private struct CameraMovePanel: View {
  let model: DocumentModel
  let clock: bmapp.CameraClock
  let move: bmapp.CameraMove
  let keys: [bmapp.CameraTrackKey]

  private var gap: Double {
    let from = keys.first { String($0.id) == String(move.from) }, to = keys.first { String($0.id) == String(move.to) }
    return max(0, (to?.seconds ?? 0) - (from?.seconds ?? 0))
  }
  private static let curves: [(id: String, label: String)] = [
    ("easeInOut", "Ease In and Out"), ("easeIn", "Ease In (Starts Slow)"), ("easeOut", "Ease Out (Lands Soft)"),
    ("linear", "Even Speed"), ("holdThenMove", "Hold, Then Move"), ("snap", "Snap (Fast Start, Soft Landing)"),
  ]

  var body: some View {
    let preset = String(move.preset)
    Section {
      Picker("Preset", selection: Binding(get: { preset }, set: { CameraPresetPicker.choose(model: model, clock: clock, from: String(move.from), preset: $0) })) {
        ForEach(CameraPresets.all, id: \.id) { p in
          Text(String(p.label)).tag(String(p.id))
        }
      }
      Toggle("Hard Cut", isOn: Binding(get: { move.cut }, set: { on in set { $0.cut = on } }))
      if !move.cut {
        Toggle("Flow Through Keys", isOn: Binding(get: { move.flowThrough }, set: { on in set { $0.flowThrough = on } }))
          .help("The camera passes through the keys without stopping")
        if !move.flowThrough {
          Picker("Speed", selection: Binding(get: { String(move.curve) }, set: { kind in set { $0.curve = std.string(kind) } })) {
            ForEach(Self.curves, id: \.id) { Text($0.label).tag($0.id) }
          }
          if String(move.curve) != "linear" {
            CameraSliderRow("Speed Strength", value: move.strength, range: 0...1, step: 0.05, format: percent) { value, more in
              set(more) { $0.strength = value }
            }
          }
          if gap > 0.05 {
            CameraSliderRow("Turn in the Last", value: min(move.turnLast, gap), range: 0...gap, step: 0.05,
                            format: { $0 > 0 ? "\($0.formatted(.number.precision(.fractionLength(2)))) s" : "Off" }) { value, more in
              set(more) { $0.turnLast = value }
            }
          }
        }
        Picker("Path", selection: Binding(get: { move.straight }, set: { straight in set { $0.straight = straight } })) {
          Text("Arc Around the Target").tag(false)
          Text("Straight Line").tag(true)
        }
        Picker("Orbit", selection: Binding(get: { String(move.orbit) }, set: { way in set { $0.orbit = std.string(way) } })) {
          Text("Shortest Way").tag("shortest")
          Text("Clockwise").tag("cw")
          Text("Counterclockwise").tag("ccw")
        }
        if String(move.orbit) != "shortest" {
          Stepper(value: Binding(get: { Int(move.extraTurns) }, set: { turns in set { $0.extraTurns = Int32(turns) } }), in: 0...5) {
            LabeledContent("Extra Turns", value: "\(move.extraTurns)")
          }
        }
        CameraSliderRow("Overshoot", value: move.overshoot, range: 0...1, step: 0.01, format: percent) { value, more in
          set(more) { $0.overshoot = value }
        }
        CameraSliderRow("Handheld Shake", value: move.shake, range: 0...3, step: 0.05, format: { $0.formatted(.number.precision(.fractionLength(2))) }) { value, more in
          set(more) { $0.shake = value }
        }
        if move.shake > 0 {
          CameraSliderRow("Shake Speed", value: move.shakeFrequency, range: 0.1...4, step: 0.05,
                          format: { "\($0.formatted(.number.precision(.fractionLength(2)))) Hz" }) { value, more in
            set(more) { $0.shakeFrequency = value }
          }
        }
        CameraSliderRow("Motion Blur", value: move.motionBlur, range: 0...1, step: 0.01, format: percent) { value, more in
          set(more) { $0.motionBlur = value }
        }
        .help("Kept for the web app's videos: this app draws the camera's moves without motion blur")
      }
    } header: {
      Text("Camera Move · \(timecode(gap)) long\(move.user ? "" : " · Automatic")")
    } footer: {
      Text(CameraPresets.hint(preset)).font(.caption).foregroundStyle(.secondary)
    }
  }

  private func set(_ continuing: Bool = false, _ change: (inout bmapp.CameraMove) -> Void) {
    var next = move
    change(&next)
    model.context.perform { $0.setCameraMove(clock, next, continuing) }
  }
}

private func degrees(_ value: Double) -> String { "\(Int(value.rounded()))°" }
private func percent(_ value: Double) -> String { "\(Int((value * 100).rounded()))%" }

/// A slider with its value beside it. `commit(value, continuing)`: continuing is true for every
/// change of a drag after its first, so the drag is one undo step.
private struct CameraSliderRow: View {
  let title: String
  let value: Double
  let range: ClosedRange<Double>
  let step: Double
  let format: (Double) -> String
  let commit: (Double, Bool) -> Void
  // A drag is one undo step: its first change starts it, the rest grow it. A change outside a
  // drag (the keyboard, VoiceOver) is a step of its own.
  @State private var dragging = false
  @State private var started = false

  init(_ title: String, value: Double, range: ClosedRange<Double>, step: Double, format: @escaping (Double) -> String,
       commit: @escaping (Double, Bool) -> Void) {
    self.title = title
    self.value = value
    self.range = range
    self.step = step
    self.format = format
    self.commit = commit
  }

  var body: some View {
    LabeledContent(title) {
      HStack(spacing: 8) {
        Slider(value: Binding(get: { min(range.upperBound, max(range.lowerBound, value)) }, set: { raw in
          let next = min(range.upperBound, max(range.lowerBound, (raw / step).rounded() * step))
          guard abs(next - value) > 1e-9 else { return }
          commit(next, dragging && started)
          started = dragging
        }), in: range) { editing in
          dragging = editing
          started = false
        }
        .labelsHidden()
        .accessibilityLabel(title)
        .accessibilityValue(format(value))
        Text(format(value)).monospacedDigit().foregroundStyle(.secondary).lineLimit(1).frame(width: 64, alignment: .trailing)
      }
    }
  }
}

/// A number typed in (committed on Return or leaving the field), with its unit.
private struct CameraNumberRow: View {
  let title: String
  let value: Double
  let range: ClosedRange<Double>
  let unit: String
  let step: Double?
  let commit: (Double, Bool) -> Void

  init(_ title: String, value: Double, range: ClosedRange<Double>, unit: String, step: Double? = nil,
       commit: @escaping (Double, Bool) -> Void) {
    self.title = title
    self.value = value
    self.range = range
    self.unit = unit
    self.step = step
    self.commit = commit
  }

  var body: some View {
    LabeledContent(title) {
      HStack(spacing: 6) {
        TextField(title, value: Binding(get: { (value * 100).rounded() / 100 }, set: { typed in
          let next = min(range.upperBound, max(range.lowerBound, typed))
          if typed.isFinite, abs(next - value) > 1e-6 { commit(next, false) }
        }), format: .number.precision(.fractionLength(0...2)))
        .labelsHidden()
        .multilineTextAlignment(.trailing)
        .monospacedDigit()
        .frame(width: 86)
        if let step {
          Stepper(title, value: Binding(get: { value }, set: { next in
            commit(min(range.upperBound, max(range.lowerBound, next)), false)
          }), step: step)
          .labelsHidden()
        }
        Text(unit).foregroundStyle(.secondary).frame(width: 36, alignment: .leading)
      }
    }
  }
}
