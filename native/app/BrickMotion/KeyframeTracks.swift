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
    var id: UInt32
    var name: String
    var keys: [bmapp.Keyframe] = []
    var baked = false
    var members: [UInt32] = []
  }

  let model: DocumentModel
  @Bindable var workspace: AnimationWorkspace
  let labelWidth: CGFloat
  @State private var objects: [Object] = []
  @State private var target: UInt32?
  @State private var query = ""
  @State private var property = KeyProperty.positionX
  @State private var editor = false
  @State private var rangeEditor = false
  @State private var motionReport = false
  @State private var value = 0.0
  @State private var curve = 0
  @State private var drag: (bmapp.KeyChannel, Int32, CGFloat)?

  private var session: bmapp.Session { model.document.session }
  private var scene: bmapp.KeyScene { session.keyScene() }
  private var frame: Int { Int(scene.first) + Int((workspace.time * Double(scene.fps)).rounded()) }
  private var selected: Object? { objects.first { $0.id == target } }
  private var keys: [bmapp.Keyframe] { selected?.keys ?? [] }
  private var range: ClosedRange<Double> { Double(scene.first)...Double(scene.last) }

  var body: some View {
    VStack(spacing: 0) {
      filmTools
      Divider()
      HStack(spacing: 0) {
        objectList
        Divider()
        if let selected {
          dopeSheet(selected)
        } else {
          VStack(spacing: 6) {
            Image(systemName: "diamond").font(.title2).foregroundStyle(.secondary)
            Text("Select an Object").font(.headline)
            Text("Choose a part to add or edit its keys.").font(.callout).foregroundStyle(.secondary)
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
    }
    .onChange(of: model.snapshot.version, initial: true) { refresh() }
    .onChange(of: Array(model.snapshot.selection), initial: true) { _, pieces in
      guard let p = pieces.first else { return }
      if !objects.contains(where: { $0.members.contains(p) }) { refresh() }
      if let object = objects.first(where: { $0.members.contains(p) }) { target = object.id }
    }
    .onChange(of: target) { _, selection in
      if let selection, let row = objects.first(where: { $0.id == selection }),
         Array(model.snapshot.selection) != row.members {
        model.select(pieces: row.members)
      }
    }
  }

  private var filmTools: some View {
    HStack(spacing: 9) {
      Button { adjacent(after: false) } label: { Image(systemName: "chevron.left") }
        .buttonStyle(.borderless).disabled(keys.isEmpty).help("Previous Key").accessibilityLabel("Previous key")
      Button { adjacent(after: true) } label: { Image(systemName: "chevron.right") }
        .buttonStyle(.borderless).disabled(keys.isEmpty).help("Next Key").accessibilityLabel("Next key")
      Text("Frame \(frame)").font(.caption.monospacedDigit())
        .accessibilityLabel("Frame \(frame)")
      Slider(value: Binding(get: { min(range.upperBound, max(range.lowerBound, Double(frame))) },
                            set: { seek(Int($0.rounded())) }), in: range, step: 1)
        .labelsHidden()
        .accessibilityLabel("Scene frame")
        .frame(minWidth: 60, maxWidth: 178)
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
        Button("Bake Selected Flight", action: bake)
          .disabled(!scene.buildLinked || selected?.members.count != 1 || !workspace.ready)
        Button("Check Motion") { workspace.checkMotion(model: model) }
          .disabled(selected == nil || workspace.checkingMotion)
      } label: {
        Label("Scene", systemImage: "slider.horizontal.3")
      }
      .fixedSize()
      .popover(isPresented: $rangeEditor, arrowEdge: .bottom) {
        KeyScenePopover(model: model, initial: scene)
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
          Text(result.text).font(.callout).padding(12).frame(maxWidth: 290, alignment: .leading)
        }
      }
    }
    .font(.callout)
    .controlSize(.small)
    .padding(.horizontal, 10)
    .frame(height: 34)
  }

  private var objectList: some View {
    VStack(spacing: 0) {
      TextField("Filter Objects", text: $query)
        .textFieldStyle(.roundedBorder).controlSize(.small)
        .padding(7)
        .accessibilityLabel("Filter animated objects")
      List(selection: $target) {
        ForEach(objects.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }) { object in
          HStack {
            Label(object.name, systemImage: object.members.count > 1 ? "square.stack.3d.up" : "cube").lineLimit(1)
            Spacer(minLength: 4)
            if object.baked { Image(systemName: "link.badge.plus").accessibilityLabel("Baked flight") }
            if !object.keys.isEmpty { Image(systemName: "diamond.fill").foregroundStyle(Color.accentColor).accessibilityLabel("Has keys") }
          }
          .font(.callout)
          .tag(object.id)
        }
      }
      .listStyle(.plain)
      .accessibilityLabel("Objects")
    }
    .frame(width: 164)
    .background(.bar)
  }

  private func dopeSheet(_ object: Object) -> some View {
    GeometryReader { geometry in
      let scale = TimelineScale(width: max(260, geometry.size.width - labelWidth - 20) * workspace.zoom,
                                duration: Double(scene.last - scene.first))
      ScrollView(.vertical) {
        HStack(alignment: .top, spacing: 0) {
          lanes
          Divider().frame(height: 24 + 24 * CGFloat(KeyProperty.allCases.count))
          ScrollView(.horizontal) {
            keyGrid(object, scale: scale)
              .padding(.horizontal, 9)
          }
        }
      }
    }
  }

  private var lanes: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("Properties").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
        .frame(height: 24)
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
      ForEach(KeyProperty.allCases, id: \.rawValue) { lane in
        ZStack(alignment: .leading) {
          Rectangle().fill(lane.rawValue % 2 == 0 ? .primary.opacity(0.027) : Color.clear)
          ForEach(object.keys.filter { $0.channel == lane.channel }, id: \.frame) { key in
            Button { edit(lane, frame: Int(key.frame)) } label: {
              Image(systemName: key.interpolation == .Hold ? "diamond.inset.filled" : "diamond.fill")
                .font(.system(size: 8))
                .foregroundStyle(Int(key.frame) == frame ? .primary : Color.accentColor)
                .frame(width: 18, height: 24).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .offset(x: scale.x(Double(key.frame - scene.first)) - 9 + delta(for: key))
            .accessibilityLabel("\(lane.title), frame \(key.frame), value \(key.value.formatted())")
            .contextMenu {
              Button("Move to Playhead") { retime(key, to: frame) }.disabled(Int(key.frame) == frame)
              Divider()
              ForEach(0..<3) { style in
                Button(curveName(style)) { change(key, curve: style) }
              }
              Divider()
              Button("Delete Key", role: .destructive) { delete(key) }
            }
            .simultaneousGesture(DragGesture(minimumDistance: 4).onChanged { event in
              drag = (key.channel, key.frame, event.translation.width)
            }.onEnded { event in
              let offset = Int((event.translation.width * scale.duration / scale.width).rounded())
              let proposed = max(Int(scene.first), min(Int(scene.last), Int(key.frame) + offset))
              drag = nil
              retime(key, to: proposed)
            })
          }
        }
        .frame(height: 24)
        .overlay(alignment: .bottom) { Divider() }
      }
    }
    .frame(width: scale.width)
    .overlay(alignment: .topLeading) {
      Rectangle()
        .fill(Color.accentColor)
        .frame(width: 1)
        .offset(x: scale.x(Double(frame - Int(scene.first))))
        .allowsHitTesting(false)
    }
  }

  private func frameRuler(_ scale: TimelineScale) -> some View {
    let first = Int(scene.first)
    let last = Int(scene.last)
    return Canvas { context, size in
      let interval = max(1, Int(scale.interval))
      for frame in stride(from: first, through: last, by: interval) {
        let x = scale.x(Double(frame - first))
        var tick = Path()
        tick.move(to: CGPoint(x: x, y: size.height - 5))
        tick.addLine(to: CGPoint(x: x, y: size.height))
        context.stroke(tick, with: .color(.secondary.opacity(0.5)), lineWidth: 0.5)
        context.draw(Text("\(frame)").font(.system(size: 9, design: .monospaced)).foregroundStyle(.secondary),
                     at: CGPoint(x: x + 3, y: size.height - 12), anchor: .leading)
      }
    }
    .frame(height: 24)
    .contentShape(Rectangle())
    .gesture(DragGesture(minimumDistance: 0).onChanged { seek(first + Int(scale.seconds($0.location.x).rounded())) })
    .accessibilityHidden(true)
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
      let title = members.count > 1 ? String($0.name) : String(session.partAt($0.object).description)
      return Object(id: $0.object, name: displayName(title), keys: Array($0.keys), baked: $0.baked, members: members)
    }
    var known = Dictionary(tracks.map { ($0.id, $0) }, uniquingKeysWith: { a, b in a.baked ? a : b })
    let keys = Set(known.keys)
    for i in model.steps.indices {
      for item in session.stepItems(i) {
        guard let part = item.pieces.first, known[part] == nil else { continue }
        known[part] = Object(id: part, name: displayName(String(item.description)), members: Array(item.pieces))
      }
    }
    objects = known.values.sorted { a, b in keys.contains(a.id) == keys.contains(b.id) ? a.id < b.id : keys.contains(a.id) }
    if let target, known[target] == nil { self.target = nil }
  }

  private func seek(_ f: Int) {
    workspace.seekScene(Double(f - Int(scene.first)) / Double(scene.fps))
  }

  private func adjacent(after: Bool) {
    let frames = keys.map { Int($0.frame) }
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
    value = session.keyValue(object.id, property.channel, Double(frame))
    curve = key?.interpolation == .Linear ? 1 : key?.interpolation == .Hold ? 2 : 0
  }

  private func insert() {
    guard let target else { return }
    let key = bmapp.Keyframe(channel: property.channel, frame: Int32(frame), value: value, interpolation: interpolation(curve))
    if model.context.perform({ $0.setKeys(target, list(key), false) }) { editor = false }
  }

  private func change(_ key: bmapp.Keyframe, curve: Int) {
    guard let target else { return }
    var changed = key
    changed.interpolation = interpolation(curve)
    model.context.perform { $0.setKeys(target, list(changed), false) }
  }

  private func delete(_ key: bmapp.Keyframe) {
    guard let target else { return }
    model.context.perform { $0.removeKeys(target, list(key)) }
  }

  private func delta(for key: bmapp.Keyframe) -> CGFloat {
    guard let drag, drag.0 == key.channel, drag.1 == key.frame else { return 0 }
    return drag.2
  }

  private func retime(_ key: bmapp.Keyframe, to frame: Int) {
    guard let target, Int(key.frame) != frame else { return }
    if model.context.perform({ $0.moveKey(target, key.channel, key.frame, Int32(frame)) }) { seek(frame) }
  }

  private func list(_ key: bmapp.Keyframe) -> bmapp.KeyList {
    var keys = bmapp.KeyList()
    keys.push_back(key)
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

  private func bake() {
    guard let target, let viewport = model.viewport else { return }
    let keys = viewport.viewport.bakeFlight(target)
    guard !keys.isEmpty else { return model.context.refuse("This part has no playable flight to bake within the scene range.") }
    model.context.perform { $0.setBakedKeys(target, keys) }
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
