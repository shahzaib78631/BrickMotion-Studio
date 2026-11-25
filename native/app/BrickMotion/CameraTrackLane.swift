// A Camera lane: a Camera track's keys (the web's Camera track) as diamonds on its video's clock
// (the Build's, or the Keyframes timeline's), and the move between each pair as a bar naming
// its preset. A key reproduces a view; Follow Camera plays the track in the viewport and in every
// export of that video. Clicking a key or a move shows it in the Camera inspector.
import SwiftUI
import BMApp

/// One video's clock, as a Camera lane reads it: seconds from the video's start.
struct CameraClockInfo {
  let clock: bmapp.CameraClock
  let fps: Double
  let duration: Double
  /// The playhead, seconds from the video's start.
  let now: Double
  let ready: Bool
  let seek: (Double) -> Void

  var isBuild: Bool { clock == .Build }
  var noun: String { isBuild ? "Build" : "timeline" }

  @MainActor static func of(_ clock: bmapp.CameraClock, model: DocumentModel, workspace: AnimationWorkspace) -> CameraClockInfo {
    if clock == .Build {
      return CameraClockInfo(clock: clock, fps: workspace.fps, duration: workspace.buildDuration, now: workspace.time,
                             ready: workspace.ready, seek: { workspace.seek($0) })
    }
    let scene = model.document.session.keyScene()
    let fps = Double(max(1, scene.fps))
    return CameraClockInfo(clock: clock, fps: fps, duration: Double(scene.last - scene.first + 1) / fps, now: workspace.time,
                           ready: true, seek: { workspace.seekScene($0) })
  }
}

/// What the Camera inspector shows: a key, or the move leaving a key, of one clock's track.
struct CameraSelection: Equatable {
  enum Item: Equatable { case key(String), move(String) }
  let clock: bmapp.CameraClock
  let item: Item

  var keyId: String? { if case .key(let id) = item { id } else { nil } }
  var moveFrom: String? { if case .move(let id) = item { id } else { nil } }
}

struct CameraTrackLane: View {
  let model: DocumentModel
  @Bindable var workspace: AnimationWorkspace
  let clock: bmapp.CameraClock
  let scale: TimelineScale
  static let height: CGFloat = 30

  @State private var drag: (id: String, seconds: Double)?

  private var info: CameraClockInfo { .of(clock, model: model, workspace: workspace) }
  private var keys: [bmapp.CameraTrackKey] { model.cameraKeys(clock) }

  var body: some View {
    ZStack(alignment: .leading) {
      if keys.isEmpty {
        Text("Add a camera key to film the \(info.noun) from your own views, or Auto-Direct it")
          .font(.caption).foregroundStyle(.tertiary)
          .lineLimit(1)
          .padding(.leading, 8)
          .allowsHitTesting(false)
      }
      ForEach(Array(keys.indices.dropLast()), id: \.self) { i in move(from: i) }
      ForEach(keys.indices, id: \.self) { i in key(i) }
    }
    .frame(width: scale.width, height: Self.height, alignment: .leading)
    .contentShape(Rectangle())
    .contextMenu { CameraLaneMenu(model: model, workspace: workspace, clock: clock) }
    .overlay(alignment: .bottom) { Divider() }
  }

  private func seconds(_ i: Int) -> Double {
    let key = keys[i]
    return drag?.id == String(key.id) ? drag?.seconds ?? key.seconds : key.seconds
  }

  private func isSelected(_ item: CameraSelection.Item) -> Bool { model.cameraSelection == CameraSelection(clock: clock, item: item) }

  // A key: click to go to it and show it in the inspector, drag along the lane to move it.
  private func key(_ i: Int) -> some View {
    let key = keys[i]
    let id = String(key.id)
    let selected = isSelected(.key(id))
    let at = seconds(i)
    let clock = info
    return Image(systemName: selected ? "diamond.fill" : "diamond")
      .font(.system(size: 12, weight: .semibold))
      .foregroundStyle(selected ? Color.accentColor : key.user ? Color.primary : Color.secondary)
      .frame(width: 18, height: Self.height)
      .contentShape(Rectangle())
      .onTapGesture {
        model.showCamera(CameraSelection(clock: self.clock, item: .key(id)))
        clock.seek(key.seconds)
      }
      .gesture(DragGesture(minimumDistance: 3).onChanged { movement in
        model.showCamera(CameraSelection(clock: self.clock, item: .key(id)))
        let moved = key.seconds + movement.translation.width / max(1, scale.width) * scale.duration
        drag = (id, min(scale.duration, max(0, moved)))
      }.onEnded { _ in
        if let change = drag, change.id == id, abs(change.seconds - key.seconds) > 1e-6 {
          model.context.perform { $0.moveCameraKey(self.clock, std.string(id), change.seconds, clock.fps, clock.duration) }
          clock.seek(change.seconds)
        }
        drag = nil
      })
      .contextMenu { CameraKeyMenu(model: model, workspace: workspace, clock: self.clock, key: key) }
      .offset(x: scale.x(at) - 9)
      .help("Camera key at \(timecode(key.seconds))\(key.user ? "" : " · automatic") · \(CameraAim.label(String(key.target))) · Drag to move")
      .accessibilityLabel("Camera key at \(timecode(key.seconds))")
      .accessibilityValue(CameraAim.label(String(key.target)))
      .accessibilityAddTraits(selected ? [.isSelected, .isButton] : [.isButton])
  }

  // The move to the next key: a bar naming its preset. Click to show it in the inspector; its
  // menu chooses the preset.
  @ViewBuilder private func move(from i: Int) -> some View {
    let start = scale.x(seconds(i)) + 8, end = scale.x(seconds(i + 1)) - 8
    let width = end - start
    if width > 4 {
      let from = keys[i]
      let id = String(from.id)
      let selected = isSelected(.move(id))
      let preset = CameraPresets.label(String(from.preset))
      Text(width > 70 ? preset : "")
        .font(.caption2)
        .lineLimit(1)
        .frame(width: width, height: 16)
        .background(Capsule().fill(Color.accentColor.opacity(selected ? 0.32 : 0.14)))
        .overlay(Capsule().strokeBorder(Color.accentColor.opacity(selected ? 0.8 : 0.35), lineWidth: 1))
        .contentShape(Capsule())
        .onTapGesture { model.showCamera(CameraSelection(clock: clock, item: .move(id))) }
        .contextMenu {
          CameraPresetPicker(model: model, clock: clock, from: from, current: String(from.preset))
        }
        .offset(x: start)
        .help("\(preset) · \(CameraPresets.hint(String(from.preset))) · Click to edit the move")
        .accessibilityLabel("Camera move, \(preset)")
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : [.isButton])
    }
  }
}

/// The label beside a Camera lane: whether the track plays, and a button adding a key.
struct CameraLaneLabel: View {
  let model: DocumentModel
  @Bindable var workspace: AnimationWorkspace
  let clock: bmapp.CameraClock

  var body: some View {
    let keys = model.cameraKeys(clock)
    let info = CameraClockInfo.of(clock, model: model, workspace: workspace)
    HStack(spacing: 2) {
      Label {
        Text("Camera").lineLimit(1).fixedSize()
      } icon: {
        // dimmed while Follow Camera is off and the viewport keeps the user's view
        Image(systemName: !keys.isEmpty && !workspace.director ? "video.slash" : "video")
      }
      .help(keys.isEmpty ? "Camera keys film the \(info.noun) from views you choose"
            : workspace.director ? "The \(info.noun) is filmed with these keys"
            : "Follow Camera is off: the viewport keeps your view. Videos of the \(info.noun) are filmed with these keys")
      Spacer(minLength: 0)
      Menu {
        CameraDirectorMenu(model: model, workspace: workspace, clock: clock)
      } label: {
        Image(systemName: "wand.and.stars")
      }
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
      .frame(width: 20)
      .disabled(!CameraLaneMenu.canAutoDirect(model: model, workspace: workspace, clock: clock))
      .help("Auto-Direct: write a camera track from the build, with keys and moves you can then change")
      .accessibilityLabel("Auto-Direct")
      Button {
        CameraLaneMenu.addKey(model: model, workspace: workspace, clock: clock)
      } label: {
        Image(systemName: "plus.diamond")
      }
      .buttonStyle(.borderless)
      .frame(width: 20)
      .disabled(!info.ready)
      .help("Add a camera key from the view at the playhead (or update the key there)")
      .accessibilityLabel("Add Camera Key from View")
    }
    .frame(height: CameraTrackLane.height)
    .contextMenu { CameraLaneMenu(model: model, workspace: workspace, clock: clock) }
  }
}

/// What a key looks at.
enum CameraAim: String, CaseIterable {
  case point, model, build, piece
  var label: String {
    switch self {
    case .point: "Fixed view"
    case .model: "Whole model"
    case .build: "What is being built"
    case .piece: "The landing piece"
    }
  }
  static func label(_ target: String) -> String { CameraAim(rawValue: target)?.label ?? "Fixed view" }
}

enum CameraPresets {
  static let all = Array(bmapp.Session.cameraPresets())
  static func label(_ id: String) -> String { all.first { String($0.id) == id }.map { String($0.label) } ?? "Smooth glide" }
  static func hint(_ id: String) -> String { all.first { String($0.id) == id }.map { String($0.hint) } ?? "" }
}

/// The web's Auto-direct styles.
enum CameraDirectorStyle: String, CaseIterable {
  case reference, showcase, turntable, calm, energetic, overhead
  var label: String {
    switch self {
    case .reference: "Speed Build"
    case .showcase: "Showcase Orbit"
    case .turntable: "Turntable"
    case .calm: "Calm"
    case .energetic: "Energetic"
    case .overhead: "Overhead"
    }
  }
  var hint: String {
    switch self {
    case .reference: "High over the base, lowering as it grows, quick swoops to the side being built, then a hard cut to a low front view"
    case .showcase: "Lowers to the front, circles slowly round the back while it is built, then cuts to a low front view"
    case .turntable: "A still frame on the whole model, turning faster as it is built, then a whip to the front and a hold"
    case .calm: "Slow glides on a long lens, no swings, an arc onto the front"
    case .energetic: "Lots of whip pans and swoops with strong motion blur"
    case .overhead: "Looks down from above the whole time"
    }
  }
}

struct CameraPresetPicker: View {
  let model: DocumentModel
  let clock: bmapp.CameraClock
  let from: bmapp.CameraTrackKey
  let current: String

  var body: some View {
    ForEach(CameraPresets.all, id: \.id) { preset in
      let id = String(preset.id)
      Toggle(isOn: Binding(get: { id == current }, set: { _ in choose(id) })) {
        Text(String(preset.label))
        Text(String(preset.hint))
      }
    }
  }

  private func choose(_ preset: String) {
    CameraPresetPicker.choose(model: model, clock: clock, from: String(from.id), preset: preset)
  }

  /// The move leaving `from` takes the preset; a slide moves about as far as the camera is now.
  static func choose(model: DocumentModel, clock: bmapp.CameraClock, from: String, preset: String) {
    let view = model.viewport?.viewport.captureSceneCamera()
    let distance = view.map { hypot($0.position.x - $0.target.x, $0.position.y - $0.target.y, $0.position.z - $0.target.z) } ?? 200
    model.context.perform { $0.chooseCameraPreset(clock, std.string(from), std.string(preset), distance) }
  }
}

private func hypot(_ x: Double, _ y: Double, _ z: Double) -> Double { (x * x + y * y + z * z).squareRoot() }

/// A key's menu: set it from the view, choose what it looks at, go to it, delete it.
struct CameraKeyMenu: View {
  let model: DocumentModel
  let workspace: AnimationWorkspace
  let clock: bmapp.CameraClock
  let key: bmapp.CameraTrackKey

  var body: some View {
    Button("Go to Key") { CameraClockInfo.of(clock, model: model, workspace: workspace).seek(key.seconds) }
    Button("Show in Inspector") { model.showCamera(CameraSelection(clock: clock, item: .key(String(key.id)))) }
    Button("Update Key from View") { CameraKeyMenu.updateFromView(model: model, clock: clock, id: String(key.id)) }
      .help("This key films the viewport's view as it is now")
    Picker("Look At", selection: Binding(get: { CameraAim(rawValue: String(key.target)) ?? .point },
                                         set: { target in CameraKeyMenu.aim(model: model, clock: clock, key: key, at: target) })) {
      ForEach(CameraAim.allCases, id: \.self) { Text($0.label).tag($0) }
    }
    Divider()
    Button("Delete Key", role: .destructive) { CameraKeyMenu.delete(model: model, clock: clock, id: String(key.id)) }
  }

  static func updateFromView(model: DocumentModel, clock: bmapp.CameraClock, id: String) {
    guard let view = model.viewport?.viewport.captureSceneCamera() else { return }
    model.context.perform { $0.setCameraKeyView(clock, std.string(id), view) }
  }

  static func delete(model: DocumentModel, clock: bmapp.CameraClock, id: String) {
    if model.context.perform({ $0.removeCameraKey(clock, std.string(id)) }), model.cameraSelection?.clock == clock,
       model.cameraSelection?.keyId == id || model.cameraSelection?.moveFrom == id {
      model.cameraSelection = nil
    }
  }

  static func aim(model: DocumentModel, clock: bmapp.CameraClock, key: bmapp.CameraTrackKey, at target: CameraAim) {
    guard target != CameraAim(rawValue: String(key.target)) else { return }
    if target == .point {
      // fixed where it looks now: the view the key gives at its own time
      guard let view = model.viewport?.viewport.cameraTrackView(key.seconds) else { return }
      model.context.perform { $0.setCameraKeyView(clock, key.id, view) }
    } else {
      model.context.perform { $0.setCameraKeyTarget(clock, key.id, std.string(target.rawValue)) }
    }
  }
}

/// Auto-direct's styles: each writes a track from the planned Build, keeping keys made by hand.
struct CameraDirectorMenu: View {
  let model: DocumentModel
  let workspace: AnimationWorkspace
  let clock: bmapp.CameraClock

  var body: some View {
    let current = String(model.document.session.cameraDirectorStyle(clock))
    Section("Auto-Direct") {
      ForEach(CameraDirectorStyle.allCases, id: \.self) { style in
        Toggle(isOn: Binding(get: { current == style.rawValue }, set: { _ in direct(style) })) {
          Text(style.label)
          Text(style.hint)
        }
      }
    }
  }

  private func direct(_ style: CameraDirectorStyle) {
    guard let viewport = model.viewport?.viewport else { return }
    let input = viewport.cameraDirectorInput()
    if model.context.perform({ $0.autoDirectCamera(clock, input, std.string(style.rawValue), 50) }) {
      model.cameraSelection = nil
      workspace.director = true
    }
  }
}

/// A lane's own menu, and its label's: add a key here, Auto-direct, follow the track, clear it.
struct CameraLaneMenu: View {
  let model: DocumentModel
  @Bindable var workspace: AnimationWorkspace
  let clock: bmapp.CameraClock

  var body: some View {
    Button("Add Camera Key from View") { CameraLaneMenu.addKey(model: model, workspace: workspace, clock: clock) }
    Menu("Auto-Direct") { CameraDirectorMenu(model: model, workspace: workspace, clock: clock) }
      .disabled(!CameraLaneMenu.canAutoDirect(model: model, workspace: workspace, clock: clock))
    Toggle("Follow Camera", isOn: $workspace.director)
    Divider()
    Button("Clear Camera Track", role: .destructive) {
      if model.context.perform({ $0.clearCameraTrack(clock) }), model.cameraSelection?.clock == clock { model.cameraSelection = nil }
    }
    .disabled(model.cameraKeys(clock).isEmpty)
  }

  /// Auto-direct reads where the Build's pieces land: it needs the planned Build (linked to the
  /// timeline, for the timeline's track).
  static func canAutoDirect(model: DocumentModel, workspace: AnimationWorkspace, clock: bmapp.CameraClock) -> Bool {
    workspace.ready && (clock == .Build || model.document.session.keyScene().buildLinked)
  }

  /// A key that films the viewport's view at the playhead (the key already there takes the view);
  /// Follow Camera turns on so the track plays.
  static func addKey(model: DocumentModel, workspace: AnimationWorkspace, clock: bmapp.CameraClock) {
    guard let view = model.viewport?.viewport.captureSceneCamera() else { return }
    let info = CameraClockInfo.of(clock, model: model, workspace: workspace)
    let halfFrame = 0.5 / max(1, info.fps)
    if let key = model.cameraKeys(clock).first(where: { abs($0.seconds - info.now) < halfFrame }) {
      model.context.perform { $0.setCameraKeyView(clock, key.id, view) }
      model.showCamera(CameraSelection(clock: clock, item: .key(String(key.id))))
    } else if model.context.perform({ $0.addCameraKey(clock, info.now, view, info.fps, info.duration) }) {
      workspace.director = true
      if let key = model.cameraKeys(clock).min(by: { abs($0.seconds - info.now) < abs($1.seconds - info.now) }) {
        model.showCamera(CameraSelection(clock: clock, item: .key(String(key.id))))
      }
    }
  }
}
