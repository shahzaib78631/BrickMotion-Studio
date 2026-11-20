import AppKit
import SwiftUI
import BMApp

struct TimelineScale {
  let width: CGFloat
  let duration: Double

  func x(_ seconds: Double) -> CGFloat { width * seconds / max(duration, 0.001) }
  func seconds(_ x: CGFloat) -> Double { duration * min(1, max(0, x / max(1, width))) }
  var interval: Double {
    let minimum = duration * 68 / max(1, width)
    let power = pow(10, floor(log10(max(0.1, minimum))))
    return [power, 2 * power, 5 * power, 10 * power].first { $0 >= minimum } ?? (10 * power)
  }
}

struct BuildTracks: View {
  let model: DocumentModel
  @Bindable var workspace: AnimationWorkspace
  let labelWidth: CGFloat
  @State private var editing: Int?
  @State private var showingParts = false
  @State private var draggedPart: AnimationWorkspace.Flight?
  @State private var pauseDrag: (Int, Double)?

  var body: some View {
    GeometryReader { geometry in
      let scale = TimelineScale(width: max(200, geometry.size.width - labelWidth - 24) * workspace.zoom,
                                duration: workspace.buildDuration)
      ScrollView(.vertical) {
        HStack(alignment: .top, spacing: 0) {
          labels
          Divider().frame(height: 173)
          ScrollView(.horizontal) {
            tracks(scale)
              .padding(.horizontal, 9)
          }
        }
      }
    }
  }

  private var labels: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("Time").font(.caption).foregroundStyle(.secondary).frame(height: 25, alignment: .leading)
      laneLabel("Sequence", "film", height: 28)
      laneLabel("Steps", "list.number", height: 40)
      laneLabel("Submodels", "square.stack.3d.up", height: 24)
      Button {
        showingParts.toggle()
      } label: {
        Label("Parts", systemImage: "cube")
          .frame(height: 28).frame(maxWidth: .infinity, alignment: .leading)
      }
      .buttonStyle(.plain)
      .disabled(activeClip == nil)
      .help("Show Parts in the Current Step")
      .popover(isPresented: $showingParts, arrowEdge: .trailing) { partList }
      laneLabel("Pauses", "pause", height: 27)
    }
    .font(.callout)
    .padding(.horizontal, 10)
    .frame(width: labelWidth, alignment: .leading)
    .background(.bar)
  }

  private func laneLabel(_ title: String, _ symbol: String, height: CGFloat) -> some View {
    Label(title, systemImage: symbol)
      .frame(height: height)
      .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func tracks(_ scale: TimelineScale) -> some View {
    VStack(spacing: 0) {
      ruler(scale)
      sequence(scale)
      steps(scale)
      arrivals(scale, submodels: true, height: 24)
      arrivals(scale, submodels: false, height: 28)
      pauses(scale)
    }
    .frame(width: scale.width)
    .overlay(alignment: .topLeading) {
      if workspace.ready {
        VStack(spacing: 0) {
          Image(systemName: "arrowtriangle.down.fill").font(.system(size: 8))
          Rectangle().frame(width: 1)
        }
        .foregroundStyle(Color.accentColor)
        .frame(width: 9)
        .offset(x: scale.x(workspace.time) - 4.5)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
      }
    }
  }

  private func ruler(_ scale: TimelineScale) -> some View {
    Canvas { context, size in
      let interval = scale.interval
      let count = Int(scale.duration / interval)
      for i in 0...min(2000, count) {
        let time = Double(i) * interval
        let x = scale.x(time)
        var tick = Path()
        tick.move(to: CGPoint(x: x, y: size.height - 6))
        tick.addLine(to: CGPoint(x: x, y: size.height))
        context.stroke(tick, with: .color(.secondary.opacity(0.5)), lineWidth: 0.5)
        context.draw(Text(timecode(time)).font(.system(size: 9, design: .monospaced)).foregroundStyle(.secondary),
                     at: CGPoint(x: x + 4, y: size.height - 13), anchor: .leading)
      }
    }
    .frame(height: 25)
    .contentShape(Rectangle())
    .gesture(DragGesture(minimumDistance: 0).onChanged { workspace.seek(scale.seconds($0.location.x)) })
    .accessibilityElement()
    .accessibilityLabel("Scrub build")
    .accessibilityValue(timecode(workspace.time))
    .accessibilityAdjustableAction { change in
      switch change {
      case .increment: workspace.seek(workspace.time + 1 / workspace.fps)
      case .decrement: workspace.seek(workspace.time - 1 / workspace.fps)
      @unknown default: break
      }
    }
    .overlay(alignment: .bottom) { Divider() }
  }

  private func sequence(_ scale: TimelineScale) -> some View {
    ZStack(alignment: .leading) {
      sequenceClip("Intro", from: 0, to: workspace.buildStart, scale: scale)
      sequenceClip("Build", from: workspace.buildStart, to: workspace.buildEnd, scale: scale)
      sequenceClip("Hero", from: workspace.buildEnd, to: workspace.duration, scale: scale)
    }
    .frame(width: scale.width, height: 28, alignment: .leading)
    .overlay(alignment: .bottom) { Divider() }
  }

  @ViewBuilder private func sequenceClip(_ title: String, from: Double, to: Double, scale: TimelineScale) -> some View {
    let width = scale.x(to - from)
    if width > 3 {
      Button { workspace.seek(from) } label: {
        Group {
          if width > 34 { Text(title).lineLimit(1).font(.caption.weight(.medium)) }
          else if width > 13 { Image(systemName: title == "Intro" ? "play" : "flag").font(.system(size: 8)) }
          else { Color.clear }
        }
        .frame(width: max(1, width - 2), height: 20)
        .background(.primary.opacity(0.075), in: RoundedRectangle(cornerRadius: 4))
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .help("\(title) · \(timecode(from))–\(timecode(to))")
      .accessibilityLabel("\(title), \(timecode(from)) to \(timecode(to))")
      .offset(x: scale.x(from) + 1)
    }
  }

  private func steps(_ scale: TimelineScale) -> some View {
    ZStack(alignment: .leading) {
      ForEach(workspace.runs) { run in
        let width = max(2, scale.x(run.end - run.start) - 2)
        let step = run.step
        let selected = step == workspace.currentStep && workspace.time >= run.start && workspace.time <= run.next
        Button {
          workspace.select(run: run)
          model.select(step: step)
        } label: {
          HStack(spacing: 5) {
            if width >= 21 { Text("\(step + 1)").font(.caption.weight(.semibold).monospacedDigit()) }
            if width > 84 { Text(stepName(step)).lineLimit(1).font(.caption) }
          }
          .padding(.horizontal, width > 38 ? 7 : 0)
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
          Button("Play Step") { workspace.play(step: step) }
          Button("Play to End") { workspace.play(step: step, throughEnd: true) }
          Button("Stop at End of Step") { workspace.select(step: step) }
          if model.steps.indices.contains(step) {
            Divider()
            Button("Select Parts") { model.select(step: step) }
            Button("Edit Step…") { editing = run.id }
            Button(model.steps[step].pinOrder ? "Unpin Order" : "Pin Order") {
              var fields = model.document.session.stepFields(step)
              fields.pinOrder.toggle()
              model.context.perform { $0.setStepFields(step, fields, false) }
            }
          }
        }
        .popover(isPresented: Binding(get: { editing == run.id }, set: { if !$0 { editing = nil } }), arrowEdge: .top) {
          StepEditor(editor: StepEditorModel(model: model, step: step))
        }
        .onDrop(of: [PartDragItem.type.rawValue], isTargeted: nil) { drop($0, at: step) }
        .offset(x: scale.x(run.start) + 1)
      }
    }
    .frame(width: scale.width, height: 40, alignment: .leading)
    .overlay(alignment: .bottom) { Divider() }
  }

  private func arrivals(_ scale: TimelineScale, submodels: Bool, height: CGFloat) -> some View {
    let selected = Set(model.snapshot.selection)
    return Canvas { context, _ in
      for clip in workspace.clips {
        for flight in clip.flights where (flight.depth > 0) == submodels {
          let rect = CGRect(x: scale.x(flight.start), y: 5,
                            width: max(1, scale.x(flight.end - flight.start) - 1), height: height - 10)
          let isSelected = selected.contains(flight.id)
          let color: Color = isSelected ? .accentColor : flight.flag.isEmpty ? (submodels ? .indigo : .secondary) : .orange
          context.fill(Path(roundedRect: rect, cornerRadius: 2), with: .color(color.opacity(isSelected ? 0.83 : 0.28)))
        }
      }
    }
    .frame(height: height)
    .contentShape(Rectangle())
    .gesture(DragGesture(minimumDistance: 0)
      .onChanged { value in
        if draggedPart == nil {
          draggedPart = workspace.nearestFlight(at: scale.seconds(value.startLocation.x), depth: submodels)
        }
      }
      .onEnded { value in
        defer { draggedPart = nil }
        guard let next = draggedPart else { return }
        if hypot(value.translation.width, value.translation.height) < 4 || submodels {
          locate(next)
        } else if let other = workspace.nearestFlight(at: scale.seconds(value.location.x), depth: false) {
          reorder(next, before: other)
        }
      })
    .onDrop(of: [PartDragItem.type.rawValue], isTargeted: nil) { providers in
      guard !submodels, let step = activeClip?.id else { return false }
      return drop(providers, at: step)
    }
    .accessibilityHidden(true)
    .overlay(alignment: .bottom) { Divider() }
  }

  private func pauses(_ scale: TimelineScale) -> some View {
    ZStack(alignment: .leading) {
      ForEach(workspace.runs) { run in
        if run.next - run.end >= 0.12 {
          let enabled = model.steps.indices.contains(run.step) && workspace.runs.last(where: { $0.step == run.step })?.id == run.id
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
  }

  private func reorder(_ a: AnimationWorkspace.Flight, before b: AnimationWorkspace.Flight) {
    guard a.step == b.step, model.steps.indices.contains(a.step) else {
      return model.context.refuse("Drag to another arrival in the same step.")
    }
    let items = model.document.session.stepItems(a.step)
    guard let to = items.firstIndex(where: { $0.pieces.contains(b.id) }) else { return }
    reorder(a, destination: to)
  }

  private func reorder(_ flight: AnimationWorkspace.Flight, destination: Int) {
    guard model.steps.indices.contains(flight.step) else { return }
    let items = model.document.session.stepItems(flight.step)
    guard let from = items.firstIndex(where: { $0.pieces.contains(flight.id) }) else { return }
    model.context.perform { $0.reorderArrival(flight.step, from, destination) }
  }

  private func stepName(_ index: Int) -> String {
    guard model.steps.indices.contains(index) else { return "Step \(index + 1)" }
    let name = String(model.steps[index].title)
    return name.isEmpty ? "\(model.steps[index].pieces) parts" : name
  }

  private func drop(_ providers: [NSItemProvider], at step: Int) -> Bool {
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
                               step: step, reference: item.reference)
        }
      }
    }
    return true
  }
}
