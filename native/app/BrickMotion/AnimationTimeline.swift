import AppKit
import SwiftUI
import BMApp

struct AnimationTimeline: View {
  let model: DocumentModel
  @Bindable var workspace: AnimationWorkspace
  let height: () -> CGFloat
  let resize: (CGFloat) -> Void
  let saveHeight: () -> Void
  let resetHeight: () -> Void
  @State private var showDiagnostics = false
  @ScaledMetric(relativeTo: .caption) private var laneLabel: CGFloat = 116
  private var navigation: TimelineNavigation { workspace.navigation }
  private var canNavigate: Bool {
    workspace.tab == .timeline || workspace.ready || (workspace.state.stale && workspace.duration > 0)
  }

  var body: some View {
    VStack(spacing: 0) {
      TimelineResizeGrip(height: height, resize: resize, save: saveHeight, reset: resetHeight)
      transport
      Divider()
      if canNavigate, workspace.tab != .motion, workspace.duration > 0, model.snapshot.pieces > 0 {
        TimelineOverview(navigation: navigation, workspace: workspace, duration: workspace.duration,
                         increment: 1 / (workspace.tab == .timeline ? Double(model.document.session.keyScene().fps) : workspace.fps),
                         seek: seek)
          .disabled(workspace.tab == .build && !workspace.ready)
        Divider()
      }
      if model.snapshot.pieces == 0 {
        ContentUnavailableView("Add Parts to Animate", systemImage: "timeline.selection",
                               description: Text("Add a part or open a model to preview its build."))
          .frame(maxHeight: .infinity)
      } else {
        switch workspace.tab {
        case .build:
          if workspace.clips.isEmpty { planPlaceholder }
          else {
            BuildTracks(model: model, workspace: workspace, labelWidth: laneLabel)
              .disabled(!workspace.ready)
          }
        case .timeline:
          KeyframeTracks(model: model, workspace: workspace, labelWidth: laneLabel)
        case .motion:
          MotionWorkspace(model: model, workspace: workspace)
        }
      }
    }
    .background(.background)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Animation timeline")
  }

  private var transport: some View {
    HStack(spacing: 12) {
      Picker("Timeline mode", selection: $workspace.tab) {
        ForEach(TimelineTab.allCases, id: \.self) { tab in Text(tab.rawValue).tag(tab) }
      }
      .pickerStyle(.segmented).labelsHidden().fixedSize()
      HStack(spacing: 3) {
        control(workspace.tab == .timeline ? "First Frame" : "Previous Moment", symbol: "backward.end",
                enabled: workspace.tab == .timeline || workspace.ready) {
          if workspace.tab == .timeline { workspace.seekScene(0) } else { workspace.travel(forward: false) }
        }
        let stopping = workspace.state.playing || workspace.state.waitingToPlay
        control(stopping ? "Pause" : "Play", symbol: stopping ? "pause.fill" : "play.fill", enabled: model.snapshot.pieces > 0) {
          workspace.togglePlayback()
        }
        control(workspace.tab == .timeline ? "Last Frame" : "Next Moment", symbol: "forward.end",
                enabled: workspace.tab == .timeline || workspace.ready) {
          if workspace.tab == .timeline { workspace.seekScene(workspace.duration) } else { workspace.travel(forward: true) }
        }
      }
      TimelineTransportTime(workspace: workspace)
      Spacer(minLength: 0)
      planStatus
      Menu {
        Picker("Playback Speed", selection: $workspace.rate) {
          ForEach([0.25, 0.5, 1, 1.5, 2, 4], id: \.self) { rate in Text(speed(rate)).tag(rate) }
        }
        Toggle("Loop Playback", isOn: $workspace.loops)
        Toggle("Follow Playhead", isOn: Binding(get: { navigation.followsPlayhead }, set: { navigation.followsPlayhead = $0 }))
        Toggle("Director Preview", isOn: $workspace.director)
        Toggle(model.document.session.snapMix().enabled ? "Snap Sounds" : "Snap Sounds (off in Step → Snap Sound)",
               isOn: Binding(get: { EditorPreferences.shared.playSnapSounds },
                             set: { EditorPreferences.shared.playSnapSounds = $0 }))
          .disabled(!model.document.session.snapMix().enabled || workspace.tab == .timeline)
        Divider()
        Button("Show Assembled Model", action: workspace.rest)
      } label: {
        Label(speed(workspace.rate), systemImage: "speedometer")
          .font(.caption.monospacedDigit())
      }
      .fixedSize()
      .help("Playback Options")
      if workspace.tab != .motion {
        Divider().frame(height: 16)
        HStack(spacing: 3) {
          control("Centre on Playhead", symbol: "scope", enabled: canNavigate && navigation.zoom > 1) {
            navigation.reveal(workspace.time, duration: workspace.duration, centred: true)
          }
          control("Zoom Timeline Out", symbol: "minus", enabled: canNavigate && navigation.zoom > 1) { zoom(1 / 1.6) }
          Button(action: navigation.fit) {
            Text(navigation.zoom == 1 ? "Fit" : "\(Int((navigation.zoom * 100).rounded()))%")
              .font(.caption.monospacedDigit()).frame(minWidth: 43)
          }
          .buttonStyle(.borderless)
          .disabled(!canNavigate)
          .help("Fit the entire timeline")
          .accessibilityLabel("Fit Timeline")
          .accessibilityValue("\(Int((navigation.zoom * 100).rounded())) percent")
          control("Zoom Timeline In", symbol: "plus", enabled: canNavigate && navigation.zoom < TimelineNavigation.maximumZoom) { zoom(1.6) }
        }
      }
    }
    .padding(.horizontal, 12)
    .frame(height: 39)
    .background(.bar)
  }

  private func zoom(_ factor: Double) {
    navigation.zoomBy(factor, playhead: workspace.time, duration: workspace.duration)
  }

  private func seek(_ time: Double) {
    if workspace.tab == .timeline {
      let fps = Double(model.document.session.keyScene().fps)
      workspace.seekScene((time * fps).rounded() / fps)
    } else { workspace.seek(time) }
  }

  @ViewBuilder private var planStatus: some View {
    if workspace.tab == .build && workspace.bakingFlights {
      HStack(spacing: 6) {
        ProgressView().controlSize(.mini)
        Text("Preparing Keyframes…")
      }
      .font(.caption).foregroundStyle(.secondary)
      .accessibilityElement(children: .combine)
    } else if workspace.busy {
      HStack(spacing: 6) {
        ProgressView().controlSize(.mini)
        Text(workspace.planningLabel).lineLimit(1)
      }
      .font(.caption).foregroundStyle(.secondary)
      .accessibilityElement(children: .combine)
    } else if workspace.ready {
      if workspace.standardPreview || !workspace.diagnostics.isEmpty || !workspace.notes.isEmpty {
        Button {
          showDiagnostics.toggle()
        } label: {
          let title = workspace.standardPreview ? "Standard Preview" :
                      workspace.diagnostics.isEmpty ? "Build Notes" : "\(workspace.diagnostics.count) flagged"
          Label(title, systemImage: workspace.standardPreview || !workspace.diagnostics.isEmpty
                ? "exclamationmark.triangle" : "info.circle")
            .font(.caption).foregroundStyle(.orange)
        }
        .buttonStyle(.borderless)
        .help("Show Planner Diagnostics")
        .popover(isPresented: $showDiagnostics, arrowEdge: .top) { diagnostics }
      } else {
        Label("Build Ready", systemImage: "checkmark.circle")
          .font(.caption).foregroundStyle(.secondary)
      }
    } else if !workspace.failure.isEmpty {
      Button {
        showDiagnostics.toggle()
      } label: {
        Label("Planning Failed", systemImage: "exclamationmark.triangle")
          .font(.caption).foregroundStyle(.orange)
      }
      .buttonStyle(.borderless)
      .help("Show Planner Diagnostics")
      .popover(isPresented: $showDiagnostics, arrowEdge: .top) { diagnostics }
    } else if model.snapshot.pieces > 0 {
      Button(workspace.state.stale ? "Update Build" : "Plan Build", action: workspace.plan)
        .controlSize(.small)
    }
  }

  private var planPlaceholder: some View {
    VStack(spacing: 7) {
      if workspace.busy {
        ProgressView().controlSize(.small)
        Text(workspace.planningLabel).font(.headline)
      } else {
        Image(systemName: workspace.failure.isEmpty ? "timeline.selection" : "exclamationmark.triangle")
          .font(.title2).foregroundStyle(.secondary)
        Text(workspace.failure.isEmpty ? (workspace.state.stale ? "The Model Has Changed" : "The Build Hasn’t Been Planned") : "Unable to Plan the Build")
          .font(.headline)
        if !workspace.failure.isEmpty {
          Text(workspace.failure).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
        }
        if workspace.failure.isEmpty {
          Button("Plan Build", action: workspace.plan)
        } else {
          HStack(spacing: 8) {
            Button("Try Again") { workspace.regenerate() }
            if !workspace.standardPreview {
              Button("Try Standard Preview") { workspace.regenerate(standardPreview: true) }
            }
          }
          .controlSize(.small)
        }
      }
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var diagnostics: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text("Planner Diagnostics").font(.headline)
        Spacer()
        Button(action: copyDiagnostics) {
          Label("Copy Diagnostics", systemImage: "doc.on.doc")
        }
        .labelStyle(.iconOnly)
        .buttonStyle(.borderless)
        .help("Copy Diagnostics")
      }
      if !workspace.failure.isEmpty {
        Text(workspace.failure).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
      }
      ForEach(Array(workspace.notes.enumerated()), id: \.offset) { _, note in
        Text(note).font(.caption).foregroundStyle(.secondary)
      }
      if workspace.failure.isEmpty && !workspace.diagnostics.isEmpty {
        ScrollView {
          LazyVStack(spacing: 0) {
            ForEach(workspace.diagnostics) { move in
              Button {
                showDiagnostics = false
                workspace.seek(move.end)
                model.select(pieces: [move.id])
                model.viewport?.frameSelection(nil)
              } label: {
                HStack(alignment: .firstTextBaseline) {
                  VStack(alignment: .leading, spacing: 3) {
                    Text(displayName(move.part)).fontWeight(.medium)
                    Text(reason(move)).foregroundStyle(.secondary)
                  }
                  Spacer()
                  Text("Step \(move.step + 1)").foregroundStyle(.secondary).monospacedDigit()
                }
                .padding(.vertical, 7)
                .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
              Divider()
            }
          }
          .font(.callout)
        }
        .frame(maxHeight: workspace.diagnostics.count > 4 ? 250 : CGFloat(workspace.diagnostics.count) * 47)
      }
      HStack(spacing: 8) {
        Button(workspace.standardPreview ? "Use Native Planner" : "Rebuild") {
          showDiagnostics = false
          // A project saved with the standard planner changes back to native, as one undo step.
          var build = model.document.session.buildSettings()
          if workspace.standardPreview && build.standardPlanner {
            build.standardPlanner = false
            guard model.context.perform({ $0.setBuildSettings(build) }) else { return }
          }
          workspace.regenerate()
        }
        if !workspace.standardPreview {
          Button("Try Standard Preview") {
            showDiagnostics = false
            workspace.regenerate(standardPreview: true)
          }
          .help("Preview authored step order. Flights require manual collision review.")
        }
        Spacer()
      }
      .controlSize(.small)
    }
    .padding(14)
    .frame(width: 350)
  }

  private func copyDiagnostics() {
    let engine = String(bmapp.Session.engineVersion())
    let name = model.focusPath.last ?? String(model.document.session.title())
    var lines = ["BrickMotion \(engine) · Build diagnostics", "Model · \(displayName(name))"]
    if workspace.failure.isEmpty {
      lines.append(contentsOf: workspace.notes)
      lines.append(contentsOf: workspace.diagnostics.map { "Step \($0.step + 1) · \($0.part) · \(reason($0))" })
    } else {
      lines.append(workspace.failure)
    }
    Pasteboard.write(lines.joined(separator: "\n"))
  }

  private func reason(_ move: AnimationWorkspace.Flight) -> String {
    switch move.flag {
    case "unjoined": "No connection found"
    case "no-direction": "Connectors have no common insertion direction"
    case "blocked": move.blocker.isEmpty ? "Insertion is blocked" : "Blocked by \(displayName(move.blocker))"
    case "no-exit": "No clear path to the seat"
    case "authored-crossing": "The authored path crosses another part"
    case "budget": "The planner did not finish this move"
    default: move.flag.replacingOccurrences(of: "-", with: " ").capitalized
    }
  }

  private func control(_ title: String, symbol: String, enabled: Bool = true, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: symbol).font(.system(size: 11, weight: .medium)).frame(width: 23, height: 24)
    }
    .buttonStyle(.borderless)
    .disabled(!enabled)
    .help(title)
    .accessibilityLabel(title)
  }

  private func speed(_ rate: Double) -> String { rate.formatted(.number.precision(.fractionLength(0...2))) + "×" }
}

private struct TimelineTransportTime: View {
  let workspace: AnimationWorkspace

  var body: some View {
    let label = timecode(workspace.time)
    Text(label)
      .font(.system(.callout, design: .monospaced).weight(.medium))
      .foregroundStyle(workspace.ready ? .primary : .secondary)
      .accessibilityLabel("Playhead time")
      .accessibilityValue(label)
      .fixedSize()
  }
}

func timecode(_ seconds: Double) -> String {
  let tenths = Int(max(0, seconds) * 10)
  return String(format: "%02d:%02d.%d", tenths / 600, (tenths / 10) % 60, tenths % 10)
}
