import AppKit
import SwiftUI
import BMApp

struct AnimationTimeline: View {
  let model: DocumentModel
  @Bindable var workspace: AnimationWorkspace
  @State private var showDiagnostics = false
  @ScaledMetric(relativeTo: .caption) private var laneLabel: CGFloat = 116

  var body: some View {
    VStack(spacing: 0) {
      transport
      Divider()
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
              .opacity(workspace.ready ? 1 : 0.55)
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
      Text(timecode(workspace.time))
        .font(.system(.callout, design: .monospaced).weight(.medium))
        .foregroundStyle(workspace.ready ? .primary : .secondary)
        .accessibilityLabel("Playhead time")
        .accessibilityValue(timecode(workspace.time))
        .fixedSize()
      Spacer(minLength: 0)
      planStatus
      Menu {
        Picker("Playback Speed", selection: $workspace.rate) {
          ForEach([0.25, 0.5, 1, 1.5, 2, 4], id: \.self) { rate in Text(speed(rate)).tag(rate) }
        }
        Toggle("Loop Playback", isOn: $workspace.loops)
        Toggle("Director Preview", isOn: $workspace.director)
        Divider()
        Button("Show Assembled Model", action: workspace.rest)
      } label: {
        Label(speed(workspace.rate), systemImage: "speedometer")
          .font(.caption.monospacedDigit())
      }
      .fixedSize()
      .help("Playback Options")
      HStack(spacing: 3) {
        control("Zoom Out", symbol: "minus", enabled: workspace.zoom > 1) { workspace.zoom = max(1, workspace.zoom / 1.6) }
        control("Fit Timeline", symbol: "arrow.left.and.right") { workspace.zoom = 1 }
        control("Zoom In", symbol: "plus", enabled: workspace.zoom < 48) { workspace.zoom = min(48, workspace.zoom * 1.6) }
      }
    }
    .padding(.horizontal, 12)
    .frame(height: 39)
    .background(.bar)
  }

  @ViewBuilder private var planStatus: some View {
    if workspace.busy {
      HStack(spacing: 6) {
        ProgressView().controlSize(.mini)
        Text(workspace.state.stale ? "Updating Build…" : "Planning Build…")
      }
      .font(.caption).foregroundStyle(.secondary)
      .accessibilityElement(children: .combine)
    } else if workspace.ready {
      if !workspace.diagnostics.isEmpty || !workspace.notes.isEmpty {
        Button {
          showDiagnostics.toggle()
        } label: {
          let title = workspace.diagnostics.isEmpty ? "Build Notes" : "\(workspace.diagnostics.count) flagged"
          Label(title, systemImage: workspace.diagnostics.isEmpty ? "info.circle" : "exclamationmark.triangle")
            .font(.caption).foregroundStyle(.orange)
        }
        .buttonStyle(.borderless)
        .help("Show Planner Diagnostics")
        .popover(isPresented: $showDiagnostics, arrowEdge: .top) { diagnostics }
      } else {
        Label("Build Ready", systemImage: "checkmark.circle")
          .font(.caption).foregroundStyle(.secondary)
      }
    } else if model.snapshot.pieces > 0 {
      Button(workspace.state.stale ? "Update Build" : "Plan Build", action: workspace.plan)
        .controlSize(.small)
    }
  }

  private var planPlaceholder: some View {
    VStack(spacing: 7) {
      if workspace.busy {
        ProgressView().controlSize(.small)
        Text("Preparing Build Playback").font(.headline)
      } else {
        Image(systemName: workspace.failure.isEmpty ? "timeline.selection" : "exclamationmark.triangle")
          .font(.title2).foregroundStyle(.secondary)
        Text(workspace.failure.isEmpty ? (workspace.state.stale ? "The Model Has Changed" : "The Build Hasn’t Been Planned") : "Unable to Plan the Build")
          .font(.headline)
        if !workspace.failure.isEmpty {
          Text(workspace.failure).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
        }
        Button(workspace.failure.isEmpty ? "Plan Build" : "Try Again", action: workspace.plan)
      }
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var diagnostics: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Planner Diagnostics").font(.headline)
      ForEach(Array(workspace.notes.enumerated()), id: \.offset) { _, note in
        Text(note).font(.caption).foregroundStyle(.secondary)
      }
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
    .padding(14)
    .frame(width: 350)
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

func timecode(_ seconds: Double) -> String {
  let tenths = Int(max(0, seconds) * 10)
  return String(format: "%02d:%02d.%d", tenths / 600, (tenths / 10) % 60, tenths % 10)
}
