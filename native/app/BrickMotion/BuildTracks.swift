import AppKit
import SwiftUI
import BMApp

struct BuildTracks: View {
  let model: DocumentModel
  @Bindable var workspace: AnimationWorkspace
  let labelWidth: CGFloat
  @State private var editing: Int?
  @State private var motionStep: Int?
  @State private var showingParts = false
  @State private var pauseDrag: (Int, Double)?
  @State private var sequenceDrag: (bmapp.SequenceSegment, Double)?
  @State private var partLayout = PartLaneLayout()
  @State private var catalogInsertion: TimelineArrivalTarget?
  private var navigation: TimelineNavigation { workspace.buildNavigation }
  private let partsTop: CGFloat = 144 + CameraTrackLane.height

  private struct StepDrag: Codable {
    static let type = "studio.brickmotion.timeline-step"
    let step: Int
    let generation, version: UInt64
  }

  private struct PartLaneInput: Equatable {
    let flights: [AnimationWorkspace.Flight]
    let width: CGFloat
    let duration: Double
  }

  var body: some View {
    ScrollView(.vertical) {
      HStack(alignment: .top, spacing: 0) {
        labels
        Divider().frame(height: partsTop + partLayout.height)
        TimelineTrackArea(navigation: navigation, duration: workspace.buildDuration, playhead: { workspace.time },
                          playing: workspace.state.playing) { scale in
          tracks(scale)
        }
      }
    }
    .onChange(of: PartLaneInput(flights: workspace.flights, width: navigation.logicalWidth,
                               duration: workspace.buildDuration), initial: true) { _, input in
      partLayout = PartLaneLayout(input.flights, scale: TimelineScale(width: input.width, duration: input.duration))
    }
  }

  private var labels: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("Time").font(.caption).foregroundStyle(.secondary).frame(height: 25, alignment: .leading)
      laneLabel("Sequence", "film", height: 28)
      cameraLabel
      laneLabel("Steps", "list.number", height: 40)
      laneLabel("Submodels", "square.stack.3d.up", height: 24)
      laneLabel("Pauses", "pause", height: 27)
      Button {
        showingParts.toggle()
      } label: {
        Label("Parts", systemImage: "cube")
          .frame(height: PartLaneLayout.rowHeight + 2 * PartLaneLayout.inset).frame(maxWidth: .infinity, alignment: .leading)
      }
      .buttonStyle(.plain)
      .disabled(activeClip == nil)
      .help("Show Parts in the Current Step")
      .popover(isPresented: $showingParts, arrowEdge: .trailing) { partList }
      Color.clear.frame(height: partLayout.height - PartLaneLayout.rowHeight - 2 * PartLaneLayout.inset)
    }
    .font(.callout)
    .padding(.horizontal, 10)
    .frame(width: labelWidth, alignment: .leading)
    .background(.bar)
  }

  private var cameraLabel: some View { CameraLaneLabel(model: model, workspace: workspace, clock: .Build) }

  private func laneLabel(_ title: String, _ symbol: String, height: CGFloat) -> some View {
    Label(title, systemImage: symbol)
      .frame(height: height)
      .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func tracks(_ scale: TimelineScale) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      BuildTimelineRuler(workspace: workspace, scale: scale)
      sequence(scale)
      CameraTrackLane(model: model, workspace: workspace, clock: .Build, scale: scale)
      steps(scale)
      submodels(scale).frame(width: scale.width)
      pauses(scale)
      parts(scale)
    }
    .frame(width: scale.width, alignment: .leading)
    .overlay(alignment: .topLeading) {
      if scale.duration > 0 { BuildTimelinePlayhead(workspace: workspace, scale: scale) }
    }
  }

  private func sequence(_ scale: TimelineScale) -> some View {
    let intro = shownDuration(.Intro)
    let build = shownDuration(.Build)
    let hero = shownDuration(.Hero)
    return ZStack(alignment: .leading) {
      sequenceClip("Intro", segment: .Intro, from: 0, duration: intro, preceding: nil, scale: scale)
      sequenceClip("Build", segment: .Build, from: intro, duration: build, preceding: .Intro, scale: scale)
      sequenceClip("Hero", segment: .Hero, from: intro + build, duration: hero, preceding: .Build, scale: scale)
    }
    .frame(width: scale.width, height: 28, alignment: .leading)
    .overlay(alignment: .bottom) { Divider() }
  }

  @ViewBuilder private func sequenceClip(_ title: String, segment: bmapp.SequenceSegment, from: Double,
                                         duration: Double, preceding: bmapp.SequenceSegment?, scale: TimelineScale) -> some View {
    let width = scale.x(duration)
    if width > 3 {
      Button { workspace.seek(from) } label: {
        TimelineClipLabel(navigation: navigation, start: scale.x(from), width: max(1, width - 2), centered: true) {
          if width > 64 {
            if sequenceDrag?.0 == segment {
              Text(duration.formatted(.number.precision(.fractionLength(1))) + " s").monospacedDigit()
            } else {
              Text(title).lineLimit(1).padding(.horizontal, 6)
            }
          } else if width > 16 {
            Image(systemName: segment == .Intro ? "play" : segment == .Build ? "hammer" : "flag")
          } else { Color.clear }
        }
        .font(.caption.weight(.medium))
        .frame(width: max(1, width - 2), height: 20)
        .background(.primary.opacity(0.075), in: RoundedRectangle(cornerRadius: 4))
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .help("\(title) · \(timecode(from))–\(timecode(from + duration))")
      .accessibilityLabel("\(title), \(timecode(from)) to \(timecode(from + duration))")
      .overlay(alignment: .trailing) {
        sequenceHandle(segment, title: title, leading: false, width: min(11, width / 2), scale: scale)
      }
      .overlay(alignment: .leading) {
        if let preceding {
          sequenceHandle(preceding, title: preceding == .Intro ? "Intro" : "Build",
                         leading: true, width: min(11, width / 2), scale: scale)
        }
      }
      .offset(x: scale.x(from) + 1)
    }
  }

  private func authoredDuration(_ segment: bmapp.SequenceSegment) -> Double {
    switch segment {
    case .Intro: workspace.buildStart
    case .Build: workspace.buildEnd - workspace.buildStart
    default: workspace.buildDuration - workspace.buildEnd
    }
  }

  private func shownDuration(_ segment: bmapp.SequenceSegment) -> Double {
    if let (active, seconds) = sequenceDrag, active == segment { return seconds }
    return authoredDuration(segment)
  }

  private func sequenceHandle(_ segment: bmapp.SequenceSegment, title: String, leading: Bool,
                              width: CGFloat, scale: TimelineScale) -> some View {
    let original = authoredDuration(segment)
    return TimelineSequenceTrim(title: title, value: shownDuration(segment), leading: leading, width: width,
      change: { delta in
        let seconds = original + Double(delta) / Double(scale.width) * scale.duration
        let minimum = segment == .Build ? 1.0 : 0.2, maximum = segment == .Build ? 1800.0 : 120.0
        sequenceDrag = (segment, min(maximum, max(minimum, (10 * seconds).rounded() / 10)))
      }, commit: {
        if let (active, seconds) = sequenceDrag, active == segment {
          model.context.perform { $0.setSequenceDuration(segment, seconds) }
        }
        sequenceDrag = nil
      }, adjust: { delta in
        model.context.perform { $0.setSequenceDuration(segment, original + delta) }
      })
  }

  private func steps(_ scale: TimelineScale) -> some View {
    let activeStep = workspace.currentStep
    let activeRun = workspace.playheadRun
    let lastRun = Dictionary(workspace.runs.map { ($0.step, $0.id) }, uniquingKeysWith: { _, last in last })
    return ZStack(alignment: .leading) {
      ForEach(visibleRuns(scale)) { run in
        let step = run.step
        let editable = lastRun[step] == run.id && model.steps.indices.contains(step)
        let hold = editable ? (pauseDrag?.0 == run.id ? pauseDrag?.1 ?? 0 : model.steps[step].pauseAfter) : 0
        let width = max(2, scale.x(run.end - run.start + hold) - 2)
        let selected = step == activeStep && run.id == activeRun
        Button {
          workspace.select(run: run)
          model.select(step: step)
        } label: {
          TimelineClipLabel(navigation: navigation, start: scale.x(run.start), width: width, centered: width <= 38) {
            HStack(spacing: 5) {
              if width >= 21 { Text("\(step + 1)").font(.caption.weight(.semibold)).monospacedDigit() }
              if width > 84 { Text(stepName(step)).lineLimit(1).font(.caption) }
            }
            .padding(.horizontal, width > 38 ? 7 : 0)
          }
          .frame(width: width, height: 28, alignment: width > 38 ? .leading : .center)
          .foregroundStyle(selected ? Color.accentColor : .primary)
          .background {
            RoundedRectangle(cornerRadius: 5)
              .fill(selected ? Color.accentColor.opacity(0.16) : Color.primary.opacity(0.075))
          }
          .overlay {
            RoundedRectangle(cornerRadius: 5)
              .strokeBorder(selected ? Color.accentColor.opacity(0.65) : Color.primary.opacity(0.09), lineWidth: 1)
          }
          .clipped()
        }
        .buttonStyle(.plain)
        .help("Step \(step + 1) · \(stepName(step))")
        .accessibilityLabel("Step \(step + 1), \(stepName(step)), from \(timecode(run.start))")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .contextMenu {
          TimelineStepMenu(step: step, model: model, editStep: { editing = run.id }, editMotion: { motionStep = run.id })
        }
        .popover(isPresented: Binding(get: { editing == run.id || motionStep == run.id }, set: { shown in
          if !shown {
            if editing == run.id { editing = nil }
            if motionStep == run.id { motionStep = nil }
          }
        }), arrowEdge: .top) {
          if motionStep == run.id {
            MotionEditor(model: model, scope: .Step, step: step, pieces: [], title: "Step \(step + 1)")
          } else {
            StepEditor(editor: StepEditorModel(model: model, step: step))
          }
        }
        .onDrag { dragStep(step) }
        .overlay(alignment: .trailing) {
          if editable {
            holdHandle(run, hold: hold, scale: scale, hitWidth: min(13, width))
          }
        }
        .onDrop(of: [StepDrag.type, PartDragItem.type.rawValue], isTargeted: nil) { providers in
          if let source = providers.first(where: { $0.hasItemConformingToTypeIdentifier(StepDrag.type) }) {
            return dropStep(source, onto: step)
          }
          return drop(providers, at: step)
        }
        .offset(x: scale.x(run.start) + 1)
      }
    }
    .frame(width: scale.width, height: 40, alignment: .leading)
    .overlay(alignment: .bottom) { Divider() }
  }

  private func holdHandle(_ run: AnimationWorkspace.Run, hold: Double, scale: TimelineScale, hitWidth: CGFloat) -> some View {
    Color.clear
      .overlay(alignment: .trailing) {
        RoundedRectangle(cornerRadius: 1)
          .fill(.secondary.opacity(0.7))
          .frame(width: 2, height: 13)
          .padding(.trailing, min(3, max(0, hitWidth - 2)))
      }
      .frame(width: hitWidth, height: 28)
      .contentShape(.rect)
      .gesture(DragGesture(minimumDistance: 2, coordinateSpace: .global)
        .onChanged { event in
          let original = model.document.session.stepFields(run.step).pauseAfter
          let delta = Double(event.translation.width) / Double(scale.width) * scale.duration
          pauseDrag = (run.id, min(10, max(0, (10 * (original + delta)).rounded() / 10)))
        }
        .onEnded { _ in
          if let (id, seconds) = pauseDrag, id == run.id { setHold(seconds, step: run.step) }
          pauseDrag = nil
        })
      .help("Drag to change the hold after Step \(run.step + 1)")
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Hold after Step \(run.step + 1)")
      .accessibilityValue("\(hold.formatted(.number.precision(.fractionLength(1)))) seconds")
      .accessibilityAdjustableAction { direction in
        if direction == .increment { setHold(hold + 0.1, step: run.step) }
        if direction == .decrement { setHold(hold - 0.1, step: run.step) }
      }
      .focusable()
      .onKeyPress(.rightArrow) { setHold(hold + 0.1, step: run.step); return .handled }
      .onKeyPress(.leftArrow) { setHold(hold - 0.1, step: run.step); return .handled }
      .overlay(alignment: .topTrailing) {
        if pauseDrag?.0 == run.id {
          Text(hold.formatted(.number.precision(.fractionLength(1))) + " s")
            .font(.caption2.monospacedDigit())
            .padding(.horizontal, 4)
            .background(.regularMaterial, in: .rect(cornerRadius: 4))
            .fixedSize()
            .offset(y: -8)
            .allowsHitTesting(false)
        }
      }
  }

  private func setHold(_ duration: Double, step: Int) {
    var fields = model.document.session.stepFields(step)
    fields.pauseAfter = min(10, max(0, duration))
    model.context.perform { $0.setStepFields(step, fields, false) }
  }

  private func submodels(_ scale: TimelineScale) -> some View {
    let selected = model.partsSelection
    let visible = visibleTimes(scale)
    return ZStack(alignment: .leading) {
      ForEach(workspace.submodelClips.filter { $0.end >= visible.lowerBound && $0.start <= visible.upperBound }) { clip in
        let name = displayName(clip.path.last ?? "")
        let width = max(2, scale.x(clip.end - clip.start))
        let nested = clip.depth > 0
        let highlighted = clip.pieces.contains(where: selected.contains)
        let tone = highlighted ? Color.accentColor : .indigo
        let timing = clip.attach.map { "Built at \(timecode(clip.start)), attaches at \(timecode($0))" } ??
          "Parts arrive from \(timecode(clip.start)) to \(timecode(clip.end))"
        Button {
          model.context.refocus(model.focusPath + clip.path)
          workspace.plan()
        } label: {
          ZStack(alignment: .leading) {
            RoundedRectangle(cornerRadius: 3).fill(tone.opacity(nested ? 0.28 : 0.18))
            if let attach = clip.attach {
              RoundedRectangle(cornerRadius: 2).fill(tone.opacity(0.75))
                .frame(width: max(1, scale.x(clip.end - attach)))
                .offset(x: scale.x(attach - clip.start))
            }
            if !nested && width >= 62 {
              TimelineClipLabel(navigation: navigation, start: scale.x(clip.start), width: width) {
                Text(name).font(.caption2.weight(.medium)).padding(.horizontal, 5)
              }
            }
          }
          .frame(width: width, height: nested ? 4 : 16)
          .clipped()
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help("\(name) · \(timing)")
        .accessibilityLabel("Open \(name) timeline")
        .accessibilityValue(timing)
        .contextMenu {
          Button("Open Submodel Timeline", systemImage: "arrow.down.right.square") {
            model.context.refocus(model.focusPath + clip.path)
            workspace.plan()
          }
          Button("Frame Submodel in View", systemImage: "viewfinder") {
            workspace.seek(clip.end)
            model.select(pieces: clip.pieces)
            model.viewport?.frameSelection(nil)
          }
        }
        .offset(x: scale.x(clip.start), y: nested ? 8 : -2)
        .zIndex(nested ? 1 : 0)
      }
    }
    .frame(width: scale.width, height: 24, alignment: .leading)
    .overlay(alignment: .bottom) { Divider() }
  }

  private func parts(_ scale: TimelineScale) -> some View {
    TimelinePartLane(layout: partLayout, model: model, selection: model.partsSelection, isEnabled: workspace.ready, catalogInsertion: catalogInsertion,
                     select: selectClip, reveal: locate, target: { pieces, x in
      arrivalTarget(excluding: pieces, at: x, scale: scale)
    }, panAtEdge: { x in
      navigation.panAtEdge(x)
    }, drop: { pieces, target, force in
      model.select(pieces: pieces)
      model.context.perform { $0.moveArrival(ViewportView.list(pieces), target.step, target.before, force) }
    }, editFlight: { workspace.editFlight($0, model: model) })
    .frame(width: scale.width, height: partLayout.height)
    .contentShape(Rectangle())
    .onDrop(of: [PartDragItem.type.rawValue], delegate: TimelineCatalogDrop(
      target: { arrivalTarget(excluding: [], at: $0, scale: scale) },
      highlight: { catalogInsertion = $0 },
      place: { providers, insertion in drop(providers, at: insertion.step, before: insertion.before) }
    ))
  }

  private func arrivalTarget(excluding pieces: [UInt32], at x: CGFloat, scale: TimelineScale) -> TimelineArrivalTarget? {
    let time = scale.time(x)
    guard let run = workspace.run(at: time), model.steps.indices.contains(run.step) else { return nil }
    let items = model.browserItems(of: run.step)
    let flights = workspace.clips.first(where: { $0.id == run.step })?.flights ?? []
    return TimelineArrivalTarget.inRun(run, at: time, scale: scale, flights: flights,
                                       excluding: Set(pieces), itemCount: items.count) { piece in
      items.firstIndex { $0.pieces.contains(piece) }
    }
  }

  private func pauses(_ scale: TimelineScale) -> some View {
    let lastRun = Dictionary(workspace.runs.map { ($0.step, $0.id) }, uniquingKeysWith: { _, last in last })
    return ZStack(alignment: .leading) {
      ForEach(visibleRuns(scale)) { run in
        if run.next - run.end >= 0.12 {
          let enabled = model.steps.indices.contains(run.step) && lastRun[run.step] == run.id
          let seconds = pauseDrag?.0 == run.id ? pauseDrag?.1 ?? 0 : run.next - run.end
          let width = max(2, scale.x(seconds))
          let strip = RoundedRectangle(cornerRadius: 2).fill(.secondary.opacity(0.27))
            .frame(width: width, height: 12)
          if enabled {
            Button {
              workspace.seek(run.end)
              editing = run.id
            } label: { strip }
              .buttonStyle(.plain)
              .overlay(alignment: .trailing) {
                if width >= 8 {
                  Rectangle().fill(.primary.opacity(0.3)).frame(width: 2, height: 8).padding(.trailing, 2)
                    .allowsHitTesting(false)
                }
              }
              .simultaneousGesture(DragGesture(minimumDistance: 4).onChanged { movement in
                let extra = movement.translation.width / scale.width * scale.duration
                let length = min(10, max(0, secondsWithoutDrag(run) + extra))
                pauseDrag = (run.id, length)
              }.onEnded { _ in
                if let change = pauseDrag, change.0 == run.id {
                  var fields = model.document.session.stepFields(run.step)
                  fields.pauseAfter = change.1
                  model.context.perform { $0.setStepFields(run.step, fields, false) }
                }
                pauseDrag = nil
              })
              .offset(x: scale.x(run.end))
              .help("Pause after Step \(run.step + 1) · Drag to change")
              .accessibilityLabel("Pause after Step \(run.step + 1)")
              .accessibilityValue(seconds.formatted(.number.precision(.fractionLength(1))) + " seconds")
          } else {
            strip.offset(x: scale.x(run.end)).accessibilityHidden(true)
          }
        }
      }
    }
    .frame(width: scale.width, height: 27, alignment: .leading)
  }

  private func visibleTimes(_ scale: TimelineScale) -> ClosedRange<Double> {
    let margin = 96 * scale.duration / max(1, scale.width)
    return (navigation.visibleStart * scale.duration - margin)...(navigation.visibleEnd * scale.duration + margin)
  }

  private func visibleRuns(_ scale: TimelineScale) -> [AnimationWorkspace.Run] {
    let visible = visibleTimes(scale)
    return workspace.runs.filter { run in
      if run.id == editing || run.id == motionStep || run.id == pauseDrag?.0 { return true }
      return run.next >= visible.lowerBound && run.start <= visible.upperBound
    }
  }

  private var activeClip: AnimationWorkspace.StepClip? {
    let step = workspace.currentStep ?? workspace.clips.first?.id
    return workspace.clips.first { $0.id == step }
  }

  private var partList: some View {
    List(activeClip?.flights ?? []) { flight in
      Button {
        locate(flight)
      } label: {
        HStack {
          Text(displayName(flight.part))
          Spacer()
          Text(timecode(flight.end)).monospacedDigit().foregroundStyle(.secondary)
        }
      }
      .buttonStyle(.plain)
      .contextMenu {
        Button("Reveal Part") { locate(flight); model.viewport?.frameSelection(nil) }
        Button("Arrive First in Step") { reorder(flight, destination: 0) }
        Button("Arrive Last in Step") {
          reorder(flight, destination: max(0, Int(model.document.session.stepItems(flight.step).size()) - 1))
        }
      }
    }
    .frame(width: 270, height: 220)
    .accessibilityLabel("Parts in step")
  }

  private func secondsWithoutDrag(_ run: AnimationWorkspace.Run) -> Double { run.next - run.end }

  private func locate(_ flight: AnimationWorkspace.Flight) {
    workspace.seek(flight.end)
    model.select(pieces: [flight.id])
    model.inspectorTab = .part
  }

  private func selectClip(_ flight: AnimationWorkspace.Flight, extending: Bool) {
    if extending {
      var selection = Set(model.snapshot.selection)
      if !selection.insert(flight.id).inserted { selection.remove(flight.id) }
      model.select(pieces: selection.sorted())
    } else { locate(flight) }
  }

  private func reorder(_ flight: AnimationWorkspace.Flight, destination: Int) {
    guard model.steps.indices.contains(flight.step), model.document.session.isLocalPiece(flight.id) else { return }
    let items = model.document.session.stepItems(flight.step)
    guard let from = items.firstIndex(where: { $0.pieces.contains(flight.id) }) else { return }
    model.context.perform { $0.reorderArrival(flight.step, from, destination) }
  }

  private func stepName(_ index: Int) -> String {
    guard model.steps.indices.contains(index) else { return "Step \(index + 1)" }
    let name = String(model.steps[index].title)
    return name.isEmpty ? "\(model.steps[index].pieces) parts" : name
  }

  private func dragStep(_ step: Int) -> NSItemProvider {
    let session = model.document.session
    let payload = StepDrag(step: step, generation: session.generation(), version: session.version())
    let provider = NSItemProvider()
    guard let data = try? JSONEncoder().encode(payload) else { return provider }
    provider.registerDataRepresentation(forTypeIdentifier: StepDrag.type, visibility: .ownProcess) { completion in
      completion(data, nil)
      return nil
    }
    return provider
  }

  private func dropStep(_ provider: NSItemProvider, onto destination: Int) -> Bool {
    let model = self.model
    provider.loadDataRepresentation(forTypeIdentifier: StepDrag.type) { data, _ in
      guard let data, let payload = try? JSONDecoder().decode(StepDrag.self, from: data) else { return }
      DispatchQueue.main.async {
        let session = model.document.session
        guard payload.generation == session.generation(), payload.version == session.version(),
              payload.step != destination, model.steps.indices.contains(payload.step),
              model.steps.indices.contains(destination) else { return }
        if model.context.perform({ $0.moveStep(payload.step, destination) }) {
          model.select(step: destination)
        }
      }
    }
    return true
  }

  private func drop(_ providers: [NSItemProvider], at step: Int, before: Int? = nil) -> Bool {
    guard let provider = providers.first else { return false }
    let model = self.model, workspace = self.workspace
    let identity = model.document.session.generation()
    let revision = model.document.session.version()
    provider.loadDataRepresentation(forTypeIdentifier: PartDragItem.type.rawValue) { data, _ in
      guard let data, data.count <= 16_384, let item = try? JSONDecoder().decode(PartDragItem.self, from: data) else { return }
      Task { @MainActor [weak model, weak workspace] in
        guard let model, let workspace, model.document.session.generation() == identity,
              model.document.session.version() == revision else { return }
        workspace.rest()
        if let view = model.viewport {
          view.window?.makeFirstResponder(view)
          view.placement.begin(item.part, colour: item.colour, turns: item.turns, mirrored: item.mirrored,
                               step: step, beforeItem: before, reference: item.reference)
        }
      }
    }
    return true
  }
}

private struct BuildTimelineRuler: View {
  let workspace: AnimationWorkspace
  let scale: TimelineScale

  var body: some View {
    let time = workspace.time
    let navigation = workspace.buildNavigation
    TimelineRuler(navigation: navigation, duration: scale.duration, playhead: time,
                  increment: 1 / workspace.fps, title: "Build playhead", value: timecode(time), seek: { workspace.seek($0) }) {
      TimelineTickFace(navigation: navigation, scale: scale, interval: scale.interval) {
        Text(timecode($0)).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
      }
      .frame(height: 25)
    }
    .frame(width: scale.width)
    .overlay(alignment: .bottom) { Divider() }
  }
}

private struct BuildTimelinePlayhead: View {
  let workspace: AnimationWorkspace
  let scale: TimelineScale

  var body: some View {
    VStack(spacing: 0) {
      Image(systemName: "arrowtriangle.down.fill").font(.system(size: 8))
      Rectangle().frame(width: 1)
    }
    .foregroundStyle(Color.accentColor.opacity(workspace.ready ? 1 : 0.45))
    .frame(width: 9)
    .offset(x: scale.x(workspace.time) - 4.5)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}
