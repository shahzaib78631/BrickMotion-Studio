import AppKit
import BMApp
import SwiftUI

enum KeyProperty: Int, CaseIterable {
  case positionX, positionY, positionZ, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, visibility

  var channel: bmapp.KeyChannel {
    [.PositionX, .PositionY, .PositionZ, .RotationX, .RotationY, .RotationZ, .ScaleX, .ScaleY, .ScaleZ, .Visibility][rawValue]
  }

  var title: String {
    ["Position X", "Position Y", "Position Z", "Rotation X", "Rotation Y", "Rotation Z", "Scale X", "Scale Y", "Scale Z", "Visibility"][rawValue]
  }

  var defaultValue: Double { rawValue >= KeyProperty.scaleX.rawValue ? 1 : 0 }
  var suffix: String { rawValue < 3 ? " studs" : rawValue < 6 ? "°" : rawValue < 9 ? "×" : "" }
}

struct KeyframeTracks: View {
  struct Object: Identifiable {
    struct ID: Hashable {
      let piece: UInt32
      let submodel: Bool
    }

    struct Marker: Identifiable {
      let frame: Int32
      let channels: Int
      var id: Int32 { frame }
    }
    var id: ID
    var name: String
    var detail: String
    var colour: Int32?
    var keys: [bmapp.Keyframe] = []
    var baked = false
    var members: [UInt32] = []
    var markers: [Marker] = []
  }

  private struct KeyPick: Hashable {
    let channel: bmapp.KeyChannel
    let frame: Int32

    init(_ key: bmapp.Keyframe) { channel = key.channel; frame = key.frame }

    func hash(into hasher: inout Hasher) {
      hasher.combine(channel.rawValue)
      hasher.combine(frame)
    }
  }

  let model: DocumentModel
  @Bindable var workspace: AnimationWorkspace
  let labelWidth: CGFloat
  @State private var objects: [Object] = []
  @State private var active: Set<Object.ID> = []
  @State private var query = ""
  @State private var property = KeyProperty.positionX
  @State private var editor = false
  @State private var rangeEditor = false
  @State private var motionReport = false
  @State private var showBakeReport = false
  @State private var confirmBake = false
  @State private var pendingBake: bmapp.FlightBake?
  @State private var detachOnBake = false
  @State private var value = 0.0
  @State private var curve = 0
  @State private var animatedOnly = false
  @State private var frameEntry = ""
  @State private var selectedKeys: Set<KeyPick> = []
  @State private var drag: (keys: Set<KeyPick>, offset: CGFloat)?
  @State private var marquee: CGRect?
  @FocusState private var editingFrame: Bool
  @FocusState private var editingKeys: Bool

  private var session: bmapp.Session { model.document.session }
  private var scene: bmapp.KeyScene { session.keyScene() }
  private var frame: Int { Int(scene.first) + Int((workspace.time * Double(scene.fps)).rounded()) }
  private var target: Object.ID? { active.count == 1 ? active.first : nil }
  private var selected: Object? { objects.first { $0.id == target } }
  private var activeObjects: [Object] { objects.filter { active.contains($0.id) } }
  private var hasActiveKeys: Bool { activeObjects.contains { !$0.keys.isEmpty } }
  private var keys: [bmapp.Keyframe] { selected?.keys ?? [] }
  private var navigation: TimelineNavigation { workspace.keyNavigation }

  var body: some View {
    VStack(spacing: 0) {
      filmTools
      Divider()
      HStack(spacing: 0) {
        objectList
        Divider()
        if active.count > 1 {
          KeyframeGroupTracks(objects: activeObjects, model: model, navigation: navigation, playing: workspace.state.playing,
                             first: scene.first, last: scene.last, frame: Int32(frame), labelWidth: labelWidth,
                             seek: { seek(Int($0)) }, play: { workspace.togglePlayback() },
                             rulerHeight: 24 + CameraTrackLane.height,
                             ruler: { scale in VStack(spacing: 0) { frameRuler(scale); cameraLane(scale) } },
                             header: { CameraLaneLabel(model: model, workspace: workspace, clock: .Timeline) })
        } else if let selected {
          dopeSheet(selected)
        } else {
          VStack(spacing: 0) {
            // the timeline's Camera lane stays, whatever is selected
            HStack(alignment: .top, spacing: 0) {
              VStack(alignment: .leading, spacing: 0) {
                Color.clear.frame(height: 24)
                CameraLaneLabel(model: model, workspace: workspace, clock: .Timeline)
              }
              .padding(.horizontal, 9)
              .frame(width: labelWidth, alignment: .leading)
              .background(.bar)
              Divider().frame(height: 24 + CameraTrackLane.height)
              TimelineTrackArea(navigation: navigation, duration: Double(scene.last - scene.first),
                                playhead: { Double(frame - Int(scene.first)) }, playing: workspace.state.playing) { scale in
                VStack(spacing: 0) { frameRuler(scale); cameraLane(scale) }
              }
            }
            .frame(height: 24 + CameraTrackLane.height)
            Divider()
            VStack(spacing: 6) {
              Image(systemName: "diamond").font(.title2).foregroundStyle(.secondary)
              Text("Select an Object").font(.headline)
              Text("Choose a part to add or edit its keys.").font(.callout).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
          }
        }
      }
    }
    .onChange(of: model.snapshot.version, initial: true) { refresh() }
    .onChange(of: Array(model.snapshot.selection), initial: true) { _, pieces in
      syncObjects(pieces)
    }
    .onChange(of: frame, initial: true) { _, next in
      if !editingFrame { frameEntry = String(next) }
    }
    .onChange(of: active) { _, _ in
      selectedKeys.removeAll()
      workspace.keySubmodel = target?.submodel == true ? target?.piece : nil
    }
    .onDisappear { workspace.keySubmodel = nil }
    .onChange(of: workspace.bakeResult) { _, result in
      if result != nil { animatedOnly = true }
    }
    .confirmationDialog("Replace Existing Keyframes?", isPresented: $confirmBake) {
      Button(detachOnBake ? "Replace Keys and Detach" : "Replace Keys") {
        if let pendingBake { workspace.runBake(pendingBake, detach: detachOnBake, model: model) }
        pendingBake = nil
      }
      Button("Cancel", role: .cancel) { pendingBake = nil }
    } message: {
      Text("Baking replaces existing keys on the affected parts with the current Build motion. You can undo the bake as one edit.")
    }
  }

  private var filmTools: some View {
    HStack(spacing: 9) {
      Button { adjacent(after: false) } label: { Image(systemName: "chevron.left") }
        .buttonStyle(.borderless).disabled(!hasActiveKeys).help("Previous Key").accessibilityLabel("Previous key")
      Button { adjacent(after: true) } label: { Image(systemName: "chevron.right") }
        .buttonStyle(.borderless).disabled(!hasActiveKeys).help("Next Key").accessibilityLabel("Next key")
      HStack(spacing: 4) {
        Text("Frame").font(.caption).foregroundStyle(.secondary)
        TextField("Frame", text: $frameEntry)
          .labelsHidden()
          .font(.caption.monospacedDigit())
          .textFieldStyle(.roundedBorder)
          .frame(width: 52)
          .focused($editingFrame)
          .accessibilityLabel("Current Animation Frame")
          .onSubmit {
            if let input = Int(frameEntry) {
              let destination = min(Int(scene.last), max(Int(scene.first), input))
              frameEntry = String(destination)
              seek(destination)
            } else {
              frameEntry = String(frame)
            }
            editingFrame = false
          }
          .onExitCommand { frameEntry = String(frame); editingFrame = false }
      }
      Divider().frame(height: 14)
      Toggle(isOn: $workspace.autoKey) {
        Label("Auto Key", systemImage: workspace.autoKey ? "record.circle.fill" : "record.circle")
      }
      .toggleStyle(.button)
      .help("Write viewport transform changes into keys at the playhead")
      Button { edit(property, frame: frame) } label: {
        Label("Insert Key", systemImage: "diamond")
      }
      .disabled(selected == nil)
      .popover(isPresented: $editor, arrowEdge: .bottom) { keyEditor }
      Spacer(minLength: 0)
      Menu {
        Button("Scene Range…") { rangeEditor = true }
        Toggle("Link Build Motion", isOn: Binding(get: { scene.buildLinked }, set: { enabled in link(enabled) }))
          .disabled(!workspace.ready && !scene.buildLinked)
        Button(selected?.baked == true ? "Rebake Selected Flight…" : "Bake Selected Flights") { bake(detach: false) }
          .disabled(active.isEmpty || !workspace.ready || workspace.bakingFlights)
        Button("Bake All and Detach Build") { bake(detach: true) }
          .disabled(!workspace.ready || workspace.bakingFlights)
        if let selected, selected.baked {
          if session.isLocalPiece(selected.id.piece) {
            Button("Use Edited Flight in Build") { useEditedFlight(selected.id.piece) }
          }
          Button("Return Flight to Planner") {
            model.context.perform { $0.returnFlightToPlanner(selected.id.piece) }
          }
        }
        Button("Check Motion") { workspace.checkMotion(model: model) }
          .disabled(selected == nil || workspace.checkingMotion)
      } label: {
        Label("Scene", systemImage: "slider.horizontal.3")
      }
      .fixedSize()
      .popover(isPresented: $rangeEditor, arrowEdge: .bottom) {
        KeyScenePopover(model: model, initial: scene)
      }
      if workspace.bakingFlights {
        ProgressView().controlSize(.mini).help("Baking Flights").accessibilityLabel("Baking Flights")
      } else if let result = workspace.bakeResult {
        Button { showBakeReport.toggle() } label: {
          Image(systemName: "checkmark.circle").foregroundStyle(.secondary)
        }
        .buttonStyle(.borderless)
        .help(result)
        .accessibilityLabel("Flight Bake Results")
        .accessibilityValue(result)
        .popover(isPresented: $showBakeReport, arrowEdge: .bottom) {
          Text(result).font(.callout).padding(12).frame(maxWidth: 290, alignment: .leading)
        }
      }
      if workspace.checkingMotion {
        ProgressView().controlSize(.mini).help("Checking Motion")
      }
      if let result = workspace.motionResult {
        Button { motionReport.toggle() } label: {
          Image(systemName: result.warning ? "exclamationmark.triangle" : "checkmark.shield")
            .foregroundStyle(result.warning ? .orange : .secondary)
        }
        .buttonStyle(.borderless)
        .help(result.text)
        .accessibilityLabel("Motion Check Results")
        .accessibilityValue(result.text)
        .popover(isPresented: $motionReport, arrowEdge: .top) {
          motionContacts(result)
        }
      }
    }
    .font(.callout)
    .controlSize(.small)
    .padding(.horizontal, 10)
    .frame(height: 34)
  }

  private func motionContacts(_ result: AnimationWorkspace.CheckResult) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Motion Check").font(.headline)
      Text(result.text).font(.callout).foregroundStyle(.secondary)
      if !result.contacts.isEmpty {
        ScrollView {
          LazyVStack(spacing: 0) {
            ForEach(Array(result.contacts.enumerated()), id: \.offset) { _, contact in
              Button {
                motionReport = false
                workspace.showMotionContact(contact, from: result, model: model)
              } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                  VStack(alignment: .leading, spacing: 3) {
                    Text("\(displayName(contact.part)) crosses \(displayName(contact.blocker))")
                      .font(.callout).lineLimit(2)
                    let time = contact.firstFrame == contact.lastFrame ? "Frame \(contact.firstFrame)" :
                      "Frames \(contact.firstFrame)–\(contact.lastFrame)"
                    Text(time).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                  }
                  Spacer()
                  Image(systemName: "arrow.up.right")
                    .font(.caption).foregroundStyle(.secondary).accessibilityHidden(true)
                }
                .padding(.vertical, 7)
                .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
              Divider()
            }
          }
        }
        .frame(maxHeight: min(248, CGFloat(result.contacts.count) * 57))
      }
    }
    .padding(14)
    .frame(width: 352, alignment: .leading)
  }

  private var objectList: some View {
    VStack(spacing: 0) {
      HStack(spacing: 4) {
        TextField("Filter Objects", text: $query)
          .textFieldStyle(.roundedBorder)
          .accessibilityLabel("Filter objects")
        Toggle(isOn: $animatedOnly) {
          Image(systemName: animatedOnly ? "diamond.fill" : "diamond")
        }
        .toggleStyle(.button)
        .help(animatedOnly ? "Show All Objects" : "Show Keyed Objects")
        .accessibilityLabel("Keyed Objects Only")
      }
      .controlSize(.small)
      .padding(7)
      List(selection: Binding(get: { active }, set: { newValue in
        chooseObjects(newValue)
      })) {
        ForEach(objects.filter { object in
          (!animatedOnly || !object.keys.isEmpty || active.contains(object.id)) &&
            (query.isEmpty || object.name.localizedCaseInsensitiveContains(query) || object.detail.localizedCaseInsensitiveContains(query))
        }) { object in
          objectRow(object)
            .tag(object.id)
            .contextMenu {
              Button("Frame in View", systemImage: "viewfinder") {
                chooseObjects([object.id])
                model.viewport?.frameSelection(nil)
              }
            }
        }
      }
      .listStyle(.plain)
      .accessibilityLabel("Objects")
    }
    .frame(width: 164)
    .background(.bar)
  }

  private func objectRow(_ object: Object) -> some View {
    HStack(spacing: 7) {
      Group {
        if let code = object.colour, let colour = model.colors[code] { Swatch(info: colour, size: 12) }
        else { Image(systemName: object.id.submodel ? "square.stack.3d.up" : "cube").foregroundStyle(.secondary) }
      }
      .frame(width: 15)
      .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 1) {
        Text(object.name).font(.callout.weight(.medium))
        Text(object.detail).font(.caption2).foregroundStyle(.secondary)
      }
      .lineLimit(1)
      Spacer(minLength: 0)
      if object.baked { Image(systemName: "link.badge.plus").accessibilityLabel("Baked flight") }
      else if !object.keys.isEmpty {
        Image(systemName: "diamond.fill").font(.caption).foregroundStyle(Color.accentColor).accessibilityLabel("Has keys")
      }
    }
    .padding(.vertical, 3)
    .help("\(object.name) · \(object.detail)")
    .accessibilityElement(children: .combine)
  }

  private func chooseObjects(_ ids: Set<Object.ID>) {
    active = ids
    let pieces = activeObjects.flatMap(\.members)
    if Set(model.snapshot.selection) != Set(pieces) { model.select(pieces: pieces) }
  }

  private func syncObjects(_ pieces: [UInt32]) {
    guard Set(activeObjects.flatMap(\.members)) != Set(pieces) else { return }
    var remaining = Set(pieces)
    var next = Set<Object.ID>()
    for row in objects where row.id.submodel && row.members.count > 1 && remaining.isSuperset(of: row.members) {
      next.insert(row.id)
      remaining.subtract(row.members)
    }
    for row in objects where !row.id.submodel && remaining.remove(row.id.piece) != nil { next.insert(row.id) }
    for row in objects where row.id.submodel && !remaining.isDisjoint(with: row.members) { next.insert(row.id) }
    active = next
  }

  private func dopeSheet(_ object: Object) -> some View {
    ScrollView(.vertical) {
      HStack(alignment: .top, spacing: 0) {
        lanes
        Divider().frame(height: 24 + CameraTrackLane.height + 24 * CGFloat(KeyProperty.allCases.count))
        TimelineTrackArea(navigation: navigation, duration: Double(scene.last - scene.first),
                          playhead: { Double(frame - Int(scene.first)) }, playing: workspace.state.playing) { scale in
          keyGrid(object, scale: scale)
        }
      }
    }
  }

  private var lanes: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("Properties").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
        .frame(height: 24)
      CameraLaneLabel(model: model, workspace: workspace, clock: .Timeline)
      ForEach(KeyProperty.allCases, id: \.rawValue) { row in
        Button { edit(row, frame: frame) } label: {
          Text(row.title).font(.callout).frame(maxWidth: .infinity, alignment: .leading)
            .frame(height: 24)
        }
        .buttonStyle(.plain)
        .help("Edit \(row.title.lowercased()) at the playhead")
      }
    }
    .padding(.horizontal, 9)
    .frame(width: labelWidth, alignment: .leading)
    .background(.bar)
  }

  private func keyGrid(_ object: Object, scale: TimelineScale) -> some View {
    VStack(spacing: 0) {
      frameRuler(scale)
      cameraLane(scale)
      ForEach(KeyProperty.allCases, id: \.rawValue) { lane in
        ZStack(alignment: .leading) {
          Rectangle().fill(lane.rawValue % 2 == 0 ? .primary.opacity(0.027) : Color.clear)
            .contentShape(.rect)
            .gesture(selectionBox(object, scale: scale))
          ForEach(visibleKeys(object, for: lane), id: \.frame) { key in
            let picked = selectedKeys.contains(KeyPick(key))
            Button { pick(key, property: lane) } label: {
              Image(systemName: key.interpolation == .Hold ? "diamond.inset.filled" : "diamond.fill")
                .font(.system(size: 8))
                .foregroundStyle(picked ? .orange : Int(key.frame) == frame ? .primary : Color.accentColor)
                .frame(width: 18, height: 24).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .offset(x: scale.x(Double(key.frame - scene.first)) - 9 + delta(for: key))
            .accessibilityLabel("\(lane.title), frame \(key.frame), value \(key.value.formatted())")
            .accessibilityAddTraits(picked ? .isSelected : [])
            .contextMenu {
              let group = group(for: key)
              Button("Edit Key…") { edit(lane, frame: Int(key.frame)) }
              Divider()
              Button("Move to Playhead") { retime(group, offset: frame - Int(key.frame), anchor: key) }
                .disabled(Int(key.frame) == frame)
              Divider()
              ForEach(0..<3) { style in
                Button(curveName(style)) { change(group, curve: style) }
              }
              Divider()
              Button(group.count == 1 ? "Delete Key" : "Delete \(group.count) Keys", role: .destructive) { delete(group) }
            }
            .simultaneousGesture(TapGesture(count: 2).onEnded { edit(lane, frame: Int(key.frame)) })
            .simultaneousGesture(DragGesture(minimumDistance: 4, coordinateSpace: .global).onChanged { event in
              let picks = drag?.keys ?? Set(group(for: key).map(KeyPick.init))
              drag = (picks, event.translation.width)
            }.onEnded { event in
              let offset = Int((event.translation.width * scale.duration / scale.width).rounded())
              let keys = group(for: key)
              drag = nil
              retime(keys, offset: offset, anchor: key)
            })
          }
        }
        .frame(height: 24)
        .overlay(alignment: .bottom) { Divider() }
      }
    }
    .frame(width: scale.width)
    .coordinateSpace(name: "KeyframeGrid")
    .focusable()
    .focused($editingKeys)
    .onDeleteCommand {
      let picked = keys.filter { selectedKeys.contains(KeyPick($0)) }
      if !picked.isEmpty { delete(picked) }
    }
    .onCommand(#selector(NSText.selectAll(_:))) { selectedKeys = Set(keys.map(KeyPick.init)) }
    .onKeyPress(.return) {
      guard selectedKeys.count == 1, let key = keys.first(where: { selectedKeys.contains(KeyPick($0)) }),
            let lane = KeyProperty(rawValue: Int(key.channel.rawValue)) else { return .ignored }
      edit(lane, frame: Int(key.frame))
      return .handled
    }
    .onKeyPress(.space) { workspace.togglePlayback(); return .handled }
    .onKeyPress(keys: [.leftArrow, .rightArrow]) { event in
      if !event.modifiers.intersection([.command, .control, .option]).isEmpty { return .ignored }
      let stride = event.modifiers.contains(.shift) ? 10 : 1
      let next = frame + (event.key == .leftArrow ? -stride : stride)
      seek(min(Int(scene.last), max(Int(scene.first), next)))
      return .handled
    }
    .overlay(alignment: .topLeading) {
      if let marquee {
        Rectangle()
          .fill(Color.accentColor.opacity(0.12))
          .overlay { Rectangle().strokeBorder(Color.accentColor.opacity(0.85)) }
          .frame(width: marquee.width, height: marquee.height)
          .offset(x: marquee.minX, y: marquee.minY)
          .allowsHitTesting(false)
          .accessibilityHidden(true)
      }
    }
    .overlay(alignment: .topLeading) {
      Rectangle()
        .fill(Color.accentColor)
        .frame(width: 1)
        .offset(x: scale.x(Double(frame - Int(scene.first))))
        .allowsHitTesting(false)
    }
  }

  private func selectionBox(_ object: Object, scale: TimelineScale) -> some Gesture {
    DragGesture(minimumDistance: 5, coordinateSpace: .named("KeyframeGrid"))
      .onChanged { event in
        marquee = CGRect(x: min(event.startLocation.x, event.location.x), y: min(event.startLocation.y, event.location.y),
                         width: abs(event.translation.width), height: abs(event.translation.height))
      }
      .onEnded { _ in
        guard let bounds = marquee else { return }
        marquee = nil
        editingKeys = true
        let picked = object.keys.filter { key in
          let x = scale.x(Double(key.frame - scene.first))
          let y = 36 + CameraTrackLane.height + CGFloat(key.channel.rawValue) * 24  // under the ruler and the Camera lane
          return bounds.insetBy(dx: -4, dy: -4).contains(CGPoint(x: x, y: y))
        }.map(KeyPick.init)
        let modifiers = NSApp.currentEvent?.modifierFlags ?? []
        if modifiers.contains(.shift) || modifiers.contains(.command) { selectedKeys.formUnion(picked) }
        else { selectedKeys = Set(picked) }
      }
  }

  private func frameRuler(_ scale: TimelineScale) -> some View {
    let first = Int(scene.first)
    return TimelineRuler(navigation: navigation, duration: scale.duration, playhead: Double(frame - first),
                         increment: 1, title: "Keyframe playhead", value: "Frame \(frame)",
                         seek: { seek(first + Int($0.rounded())) }) {
      TimelineTickFace(navigation: navigation, scale: scale, interval: max(1, scale.interval)) {
        Text("\(first + Int($0.rounded()))").font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
      }
      .frame(height: 24)
    }
  }

  private var keyEditor: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Keyframe").font(.headline)
      LabeledContent("Frame", value: "\(frame)").monospacedDigit()
      Picker("Property", selection: $property) {
        ForEach(KeyProperty.allCases, id: \.self) { item in Text(item.title).tag(item) }
      }
      if property == .visibility {
        Toggle("Visible", isOn: Binding(get: { value >= 0.5 }, set: { value = $0 ? 1 : 0 }))
      } else {
        HStack {
          Text("Value")
          Spacer()
          TextField("Value", value: $value, format: .number.precision(.fractionLength(0...4)))
            .textFieldStyle(.roundedBorder).frame(width: 74).multilineTextAlignment(.trailing)
          Text(property.suffix).foregroundStyle(.secondary)
        }
        Picker("Interpolation", selection: $curve) {
          ForEach(0..<3) { style in Text(curveName(style)).tag(style) }
        }
      }
      HStack {
        Spacer()
        Button("Cancel") { editor = false }.keyboardShortcut(.cancelAction)
        Button("Set Key", action: insert).keyboardShortcut(.defaultAction)
      }
    }
    .padding(14)
    .frame(width: 265)
    .onChange(of: property) { readValue() }
  }

  private func refresh() {
    let tracks = session.keyTracks().map {
      let members = Array($0.members)
      let id = Object.ID(piece: $0.object, submodel: !$0.baked && !session.isLocalPiece($0.object))
      let keys = Array($0.keys)
      var counts: [Int32: Int] = [:]
      for key in keys { counts[key.frame, default: 0] += 1 }
      let markers = counts.keys.sorted().map { Object.Marker(frame: $0, channels: counts[$0, default: 0]) }
      var object = describeObject(id, name: String($0.name), members: members)
      object.keys = keys
      object.baked = $0.baked
      object.markers = markers
      return object
    }
    var known = Dictionary(tracks.map { ($0.id, $0) }, uniquingKeysWith: { a, b in a.baked ? a : b })
    let keys = Set(known.keys)
    for i in model.steps.indices {
      for item in session.stepItems(i) {
        guard let part = item.pieces.first else { continue }
        let id = Object.ID(piece: part, submodel: item.submodel)
        guard known[id] == nil else { continue }
        let name = item.submodel ? item.name : item.description
        known[id] = describeObject(id, name: String(name), members: Array(item.pieces))
      }
    }
    objects = known.values.sorted { a, b in
      if keys.contains(a.id) != keys.contains(b.id) { return keys.contains(a.id) }
      if a.id.piece != b.id.piece { return a.id.piece < b.id.piece }
      return a.id.submodel && !b.id.submodel
    }
    active.formIntersection(known.keys)
    syncObjects(Array(model.snapshot.selection))
  }

  private func describeObject(_ id: Object.ID, name: String, members: [UInt32]) -> Object {
    if id.submodel {
      let count = members.count
      return Object(id: id, name: displayName(name), detail: "\(count) \(count == 1 ? "part" : "parts")", members: members)
    }
    let part = session.partAt(id.piece)
    let code = session.partColor(id.piece)
    let detail = displayName(String(part.name)) + " · " + (model.colors[code].map { String($0.name) } ?? "Colour \(code)")
    return Object(id: id, name: displayName(String(part.description)), detail: detail, colour: code, members: members)
  }

  /// The timeline's Camera lane: its keys are seconds from the first frame, on the frames' scale.
  private func cameraLane(_ scale: TimelineScale) -> some View {
    let seconds = TimelineScale(width: scale.width, duration: Double(scene.last - scene.first) / Double(max(1, scene.fps)))
    return CameraTrackLane(model: model, workspace: workspace, clock: .Timeline, scale: seconds)
  }

  private func seek(_ f: Int) {
    workspace.seekScene(Double(f - Int(scene.first)) / Double(scene.fps))
  }

  private func adjacent(after: Bool) {
    let frames = activeObjects.flatMap { $0.markers.map { Int($0.frame) } }
    if let destination = after ? frames.filter({ $0 > frame }).min() : frames.filter({ $0 < frame }).max() { seek(destination) }
  }

  private func edit(_ picked: KeyProperty, frame: Int) {
    seek(frame)
    property = picked
    readValue()
    editor = true
  }

  private func readValue() {
    guard let object = selected else { return }
    let values = object.keys.filter { $0.channel == property.channel }
    let key = values.last { Int($0.frame) <= frame } ?? values.first
    value = session.keyValue(object.id.piece, property.channel, Double(frame), object.id.submodel)
    curve = key?.interpolation == .Linear ? 1 : key?.interpolation == .Hold ? 2 : 0
  }

  private func insert() {
    guard let target else { return }
    let key = bmapp.Keyframe(channel: property.channel, frame: Int32(frame), value: value, interpolation: interpolation(curve))
    if model.context.perform({ $0.setKeys(target.piece, list(key), false, target.submodel) }) { editor = false }
  }

  private func visibleKeys(_ object: Object, for property: KeyProperty) -> [bmapp.Keyframe] {
    let length = Double(scene.last - scene.first)
    let margin = 18 * length / navigation.logicalWidth
    let first = Double(scene.first) + navigation.visibleStart * length - margin
    let last = Double(scene.first) + navigation.visibleEnd * length + margin
    return object.keys.filter { key in
      key.channel == property.channel && (Double(key.frame) >= first && Double(key.frame) <= last ||
                                           drag?.keys.contains(KeyPick(key)) == true)
    }
  }

  private func pick(_ key: bmapp.Keyframe, property: KeyProperty) {
    editingKeys = true
    self.property = property
    let id = KeyPick(key)
    let modifiers = NSApp.currentEvent?.modifierFlags ?? []
    if modifiers.contains(.command) || modifiers.contains(.shift) {
      if !selectedKeys.insert(id).inserted { selectedKeys.remove(id) }
    } else {
      selectedKeys = [id]
    }
    seek(Int(key.frame))
  }

  private func group(for key: bmapp.Keyframe) -> [bmapp.Keyframe] {
    guard selectedKeys.contains(KeyPick(key)) else { return [key] }
    return keys.filter { selectedKeys.contains(KeyPick($0)) }
  }

  private func change(_ keys: [bmapp.Keyframe], curve: Int) {
    guard let target else { return }
    let revised = keys.map { key in
      var changed = key
      changed.interpolation = interpolation(curve)
      return changed
    }
    model.context.perform { $0.setKeys(target.piece, keyList(revised), false, target.submodel) }
  }

  private func delete(_ keys: [bmapp.Keyframe]) {
    guard let target else { return }
    if model.context.perform({ $0.removeKeys(target.piece, keyList(keys), target.submodel) }) {
      selectedKeys.subtract(keys.map(KeyPick.init))
    }
  }

  private func delta(for key: bmapp.Keyframe) -> CGFloat {
    guard let drag, drag.keys.contains(KeyPick(key)) else { return 0 }
    return drag.offset
  }

  private func retime(_ keys: [bmapp.Keyframe], offset: Int, anchor: bmapp.Keyframe) {
    guard let target, let first = keys.map(\.frame).min(), let last = keys.map(\.frame).max() else { return }
    let offset = min(Int(scene.last - last), max(Int(scene.first - first), offset))
    guard offset != 0 else { return }
    if model.context.perform({ $0.moveKeys(target.piece, keyList(keys), Int32(offset), target.submodel) }) {
      selectedKeys = Set(keys.map { key in
        var moved = key
        moved.frame += Int32(offset)
        return KeyPick(moved)
      })
      seek(Int(anchor.frame) + offset)
    }
  }

  private func list(_ key: bmapp.Keyframe) -> bmapp.KeyList { keyList([key]) }

  private func keyList(_ input: [bmapp.Keyframe]) -> bmapp.KeyList {
    var keys = bmapp.KeyList()
    for key in input { keys.push_back(key) }
    return keys
  }

  private func curveName(_ value: Int) -> String { ["Smooth", "Linear", "Hold"][value] }
  private func interpolation(_ value: Int) -> bmapp.KeyInterpolation { [.Smooth, .Linear, .Hold][value] }

  private func link(_ enabled: Bool) {
    var next = scene
    next.buildLinked = enabled
    if enabled {
      let length = workspace.buildDuration / next.buildSpeed * Double(next.fps)
      next.last = max(next.last, next.buildStart + Int32(ceil(length)))
    }
    model.context.perform { $0.setKeyScene(next) }
  }

  private func bake(detach: Bool) {
    guard let viewport = model.viewport else { return }
    var pieces = bmapp.PieceList()
    for part in activeObjects.flatMap(\.members) { pieces.push_back(part) }
    guard let source = viewport.viewport.captureFlightBake(pieces, detach) else {
      model.context.refuse("Generate a Build plan before baking flights.")
      return
    }
    if source.replacesKeys() {
      pendingBake = source
      detachOnBake = detach
      confirmBake = true
    } else {
      workspace.runBake(source, detach: detach, model: model)
    }
  }

  private func useEditedFlight(_ piece: UInt32) {
    guard let view = model.viewport else { return }
    let route = view.viewport.editedFlightRoute(piece)
    guard !route.isEmpty else {
      model.context.refuse("Use two visible poses with movement and no scale change to send this flight to Build.")
      return
    }
    if model.context.perform({ $0.useFlightInBuild(piece, route) }) {
      workspace.tab = .build
      workspace.plan()
    }
  }
}

private struct KeyScenePopover: View {
  let model: DocumentModel
  let initial: bmapp.KeyScene
  @State private var scene: bmapp.KeyScene
  @Environment(\.dismiss) private var dismiss

  init(model: DocumentModel, initial: bmapp.KeyScene) {
    self.model = model
    self.initial = initial
    _scene = State(initialValue: initial)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Scene Range").font(.headline)
      integer("First Frame", value: $scene.first)
      integer("Last Frame", value: $scene.last)
      integer("Frames per Second", value: $scene.fps)
      if scene.buildLinked {
        Divider()
        integer("Build Starts", value: $scene.buildStart)
        LabeledContent("Build Speed") {
          TextField("Build speed", value: $scene.buildSpeed, format: .number.precision(.fractionLength(0...2)))
            .labelsHidden().frame(width: 74).multilineTextAlignment(.trailing)
        }
      }
      HStack {
        Spacer()
        Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
        Button("Apply") {
          if model.context.perform({ $0.setKeyScene(scene) }) { dismiss() }
        }.keyboardShortcut(.defaultAction)
      }
    }
    .padding(14)
    .frame(width: 254)
    .textFieldStyle(.roundedBorder)
    .onChange(of: scene.fps) {
      if scene.fps > 0, scene.last == initial.last {
        scene.last = initial.first + Int32((Double(initial.last - initial.first) * Double(scene.fps) / Double(initial.fps)).rounded())
      }
    }
  }

  private func integer(_ title: String, value: Binding<Int32>) -> some View {
    LabeledContent(title) {
      TextField(title, value: value, format: .number.grouping(.never))
        .labelsHidden().frame(width: 74).multilineTextAlignment(.trailing)
    }
  }
}
