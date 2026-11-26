import AppKit
import BMApp
import SwiftUI
import UniformTypeIdentifiers

struct ModelVideoTarget {
  let title: String
  let path: [String]
}

@MainActor struct VideoExportSheet: View {
  enum Layout: String, CaseIterable, Identifiable {
    case landscape = "Landscape"
    case vertical = "Vertical"
    case portrait = "Portrait"
    case square = "Square"

    var id: Self { self }

    var engine: bmapp.FrameShape {
      switch self {
      case .landscape: .Landscape
      case .vertical: .Vertical
      case .portrait: .Portrait
      case .square: .Square
      }
    }

    var dimensions: (Int, Int) {
      let size = bmapp.frameSize(engine)
      return (Int(size.width), Int(size.height))
    }

    var ratio: String { String(cString: bmapp.frameRatio(engine)) }
  }

  enum Source: String, CaseIterable, Identifiable {
    case build, keyframes, turntable
    var id: Self { self }
    var title: String { rawValue.capitalized }
    var engine: bmapp.MovieSource {
      switch self {
      case .build: .Build
      case .keyframes: .Keyframes
      case .turntable: .Turntable
      }
    }
  }

  enum Camera: Hashable {
    case director
    case track
    case viewport
    case saved(String)
  }

  enum Resolution: CaseIterable, Identifiable {
    case small, standard, large
    var id: Self { self }

    var engine: bmapp.MovieResolution {
      switch self {
      case .small: .Small
      case .standard: .Standard
      case .large: .Large
      }
    }

    func size(for layout: Layout) -> (Int, Int) {
      let size = bmapp.movieSize(layout.engine, engine)
      return (Int(size.width), Int(size.height))
    }
  }

  enum Quality: String, CaseIterable, Identifiable {
    case compact = "Compact"
    case standard = "Standard"
    case high = "High"
    var id: Self { self }

    var engine: bmapp.MovieQuality {
      switch self {
      case .compact: .Compact
      case .standard: .Standard
      case .high: .High
      }
    }
  }

  enum ExportState {
    case settings
    case queued(URL)
    case running(URL, done: Int, total: Int)
    case cancelling(URL)
    case complete(URL)
    case failed(String)
  }

  let title: String
  let focusPath: [String]
  let targets: [ModelVideoTarget]
  var focusedModel: String? { focusPath.last.map(displayName) }
  let standardPreview: Bool
  let angles: bmapp.ViewAngles
  let savedCameras: [bmapp.SceneCamera]
  /// The focused model has camera keys on the Build's clock, and on the Keyframes timeline's.
  let hasBuildTrack: Bool
  let hasTimelineTrack: Bool
  private var hasCameraTrack: Bool { hasBuildTrack || hasTimelineTrack }
  /// The project films its videos with their Camera track (the web's exportCamera "track").
  let prefersTrack: Bool
  /// Saves the choice of video camera in the project, as the web's exportCamera.
  let rememberCamera: (String) -> Void
  let snapshot: () -> Data
  let library: String
  let presentSavePanel: (NSSavePanel, @escaping (NSApplication.ModalResponse) -> Void) -> Void
  let close: () -> Void

  @State private var source: Source
  @State private var turntableSeconds = 8
  @State private var includeSnapAudio: Bool
  @State private var layout: Layout = .landscape
  @State private var resolution: Resolution = .standard
  @State private var quality: Quality = .standard
  @State private var fps = 30
  @State private var camera: Camera
  @State private var exportFocusedModel = false
  @State private var job: RenderJob?
  @State private var startupError: String?
  @State private var choosingLocation = false

  private var state: ExportState {
    if let startupError { return .failed(startupError) }
    guard let job else { return .settings }
    switch job.status {
    case .queued: return .queued(job.destination)
    case .rendering(let done, let total): return .running(job.destination, done: done, total: total)
    case .cancelling: return .cancelling(job.destination)
    case .complete: return .complete(job.destination)
    case .cancelled: return .settings
    case .interrupted: return .failed("The export was interrupted.")
    case .failed(let reason): return .failed(reason)
    }
  }

  static func show(_ context: CommandContext, targets: [ModelVideoTarget] = []) {
    guard let document = context.document, let window = context.window, window.attachedSheet == nil else { return }
    let sheet = NSWindow()
    var angles = bmapp.ViewAngles()
    if let pose = context.viewport?.viewport.camera() { angles = bmapp.viewAngles(pose) }
    let scene = document.session.sceneCameras()
    let savedCameras = Array(scene.cameras)
    let defaultCamera = targets.isEmpty && scene.useForVideo ? savedCameras.first { $0.id == scene.activeId } : nil
    let hasTrack = !document.session.cameraKeys(.Build).empty()
    let hasTimelineTrack = !document.session.cameraKeys(.Timeline).empty()
    let projectCamera: Camera = switch bmapp.defaultMovieCamera(document.session, !targets.isEmpty, angles.present) {
    case .Viewport: .viewport
    case .Track: .track
    default: .director  // a saved default is defaultCamera above
    }
    let view = VideoExportSheet(
      title: (document.displayName as NSString).deletingPathExtension,
      focusPath: document.session.focusPath().map { String($0) }, targets: targets,
      standardPreview: context.model?.animation.standardPreview == true || document.session.buildSettings().standardPlanner,
      angles: angles, savedCameras: savedCameras, hasBuildTrack: hasTrack, hasTimelineTrack: hasTimelineTrack,
      prefersTrack: String(document.session.exportCamera()) == "track" && defaultCamera == nil,
      rememberCamera: { [weak document] camera in
        guard let document else { return }
        _ = document.perform { document.session.setExportCamera(std.string(camera)) }
      },
      snapshot: { Data(String(document.session.projectBytes()).utf8) },
      library: String(bmapp.Session.ldrawDirectory()),
      presentSavePanel: { [weak sheet] panel, completion in
        guard let sheet else { return completion(.cancel) }
        panel.beginSheetModal(for: sheet, completionHandler: completion)
      },
      close: { [weak window, weak sheet] in if let sheet { window?.endSheet(sheet) } },
      source: targets.isEmpty && context.model?.animation.isKeyEditing == true ? .keyframes : .build,
      includeSnapAudio: document.session.snapMix().enabled,
      camera: defaultCamera.map { .saved(String($0.id)) } ?? projectCamera
    )
    sheet.contentViewController = NSHostingController(rootView: view)
    window.beginSheet(sheet)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
        .padding(.horizontal, 24)
        .padding(.top, 22)
        .padding(.bottom, 18)
      Divider()
      switch state {
      case .settings:
        settings.padding(.horizontal, 24).padding(.vertical, 20)
      case .queued(let destination):
        result(symbol: "clock", tint: .secondary, title: "Waiting to Render", detail: destination.lastPathComponent)
      case let .running(destination, done, total):
        activity(destination, done: done, total: total, cancelling: false)
      case .cancelling(let destination):
        activity(destination, done: 0, total: 0, cancelling: true)
      case .complete(let destination):
        result(symbol: "checkmark.circle.fill", tint: .green, title: "Video Exported", detail: destination.lastPathComponent)
      case .failed(let detail):
        result(symbol: "exclamationmark.circle.fill", tint: .orange, title: "Export Failed", detail: detail)
      }
      Divider()
      buttons
        .padding(.horizontal, 24)
        .padding(.vertical, 15)
    }
    .frame(width: 520)
  }

  private var header: some View {
    HStack(spacing: 13) {
      Image(systemName: "film")
        .font(.system(size: 22, weight: .medium))
        .foregroundStyle(Color.accentColor)
        .frame(width: 44, height: 44)
        .background(Color.accentColor.opacity(0.11), in: .rect(cornerRadius: 11))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 3) {
        Text("Export Video").font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
        Text(targets.count > 1 ? "\(targets.count.formatted()) Submodels" : targets.first?.title ?? title)
          .font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
      }
      Spacer()
    }
  }

  private var settings: some View {
    VStack(alignment: .leading, spacing: 14) {
      Picker("Source", selection: $source) {
        ForEach(Source.allCases) { Text($0.title).tag($0) }
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      HStack(spacing: 8) {
        ForEach(Layout.allCases) { option in
          Button {
            layout = option
          } label: {
            layoutOption(option)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("\(option.rawValue), \(option.ratio)")
          .accessibilityAddTraits(layout == option ? [.isSelected] : [])
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Frame Shape")

      Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 12) {
        GridRow {
          Text("Resolution").accessibilityHidden(true)
          Picker("Resolution", selection: $resolution) {
            ForEach(Resolution.allCases) { option in
              let (width, height) = option.size(for: layout)
              Text("\(width) × \(height)").tag(option)
            }
          }
          .labelsHidden()
        }
        GridRow {
          Text("Quality").accessibilityHidden(true)
          Picker("Quality", selection: $quality) {
            ForEach(Quality.allCases) { Text($0.rawValue).tag($0) }
          }
          .labelsHidden()
        }
        GridRow {
          Text("Frame Rate").accessibilityHidden(true)
          Picker("Frame Rate", selection: $fps) {
            ForEach([24, 25, 30, 50, 60], id: \.self) { Text("\($0) fps").tag($0) }
          }
          .labelsHidden()
        }
        GridRow {
          Text("Camera").accessibilityHidden(true)
          Picker("Camera", selection: $camera) {
            Text("Automatic Camera").tag(Camera.director)
            if hasCameraTrack {
              Text("Camera Track").tag(Camera.track).disabled(!allowsTrack)
            }
            Text("Viewport Angle").tag(Camera.viewport).disabled(!angles.present)
            if allowsSavedCameras && !savedCameras.isEmpty {
              Divider()
              ForEach(savedCameras, id: \.identifier) { saved in
                Text(String(saved.name)).tag(Camera.saved(String(saved.id)))
              }
            }
          }
          .labelsHidden()
        }
        logoRow
        if source == .turntable {
          GridRow {
            Text("Duration").accessibilityHidden(true)
            Picker("Duration", selection: $turntableSeconds) {
              ForEach([4, 6, 8, 12, 16], id: \.self) { Text("\($0) seconds").tag($0) }
            }
            .labelsHidden()
          }
        }
        if targets.isEmpty, let focusedModel {
          GridRow {
            Text("Model").accessibilityHidden(true)
            Picker("Model", selection: $exportFocusedModel) {
              Text("Entire Project").tag(false)
              Text(focusedModel).tag(true)
            }
            .labelsHidden()
            .frame(maxWidth: 300)
          }
        }
      }
      if source == .build && !standardPreview {
        Toggle("Include Snap Sounds", isOn: $includeSnapAudio)
      }
      Text(source == .turntable ? "Show the assembled model in one full orbit."
        : camera == .viewport ? "Keep your viewing angle and frame the model for the output shape."
        : camera == .track ? "Film the \(source == .keyframes ? "timeline" : "build") with your camera keys and moves."
        : isSavedCamera ? "Keep the saved position, target, and lens."
        : source == .keyframes ? "Render the authored scene range, including linked build motion."
        : "Follow the build, including your step holds and motion edits.")
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .onChange(of: allowsSavedCameras) { _, allows in
      if !allows && isSavedCamera { camera = .director }
    }
    .onChange(of: allowsTrack, initial: true) { _, allows in
      // the project's camera follows the video chosen: its own track when it has keys
      if !allows && camera == .track { camera = .director }
      else if allows && prefersTrack && camera == .director { camera = .track }
    }
  }

  /// One row of the settings grid: the logo, whether it shows, and its corner.
  @ViewBuilder private var logoRow: some View {
    let logo = VideoLogo.shared
    GridRow {
      Text("Logo").accessibilityHidden(true)
      HStack(spacing: 8) {
        if let preview = logo.preview {
          Image(nsImage: preview).resizable().scaledToFit()
            .frame(width: 34, height: 20)
            .opacity(logo.enabled ? 1 : 0.4)
            .accessibilityHidden(true)
          Picker("Logo", selection: Binding(get: { logo.enabled ? Optional(logo.corner) : nil },
                                            set: { corner in
                                              logo.enabled = corner != nil
                                              if let corner { logo.corner = corner }
                                            })) {
            Text("Off").tag(VideoLogo.Corner?.none)
            Divider()
            ForEach(VideoLogo.Corner.allCases) { Text($0.title).tag(Optional($0)) }
          }
          .labelsHidden()
          .fixedSize()
          Menu {
            Button("Replace Logo…", action: chooseLogo)
            Button("Remove Logo", role: .destructive) { logo.remove() }
          } label: {
            Image(systemName: "ellipsis.circle")
          }
          .menuStyle(.borderlessButton)
          .menuIndicator(.hidden)
          .fixedSize()
          .accessibilityLabel("Logo Options")
        } else {
          Button("Choose Logo…", action: chooseLogo)
        }
      }
    }
  }

  private func chooseLogo() {
    let panel = NSOpenPanel()
    panel.allowedContentTypes = VideoLogo.types
    panel.prompt = "Choose"
    panel.message = "The logo appears in a corner of every exported video."
    presentSavePanel(panel) { response in
      guard response == .OK, let url = panel.url else { return }
      do { try VideoLogo.shared.choose(url) } catch { startupError = error.localizedDescription }
    }
  }

  /// Keys belong to one video of the focused model: its Build or its Keyframes timeline (not a
  /// turntable, or another model).
  private var allowsTrack: Bool {
    let keyed = source == .build ? hasBuildTrack : source == .keyframes ? hasTimelineTrack : false
    return keyed && targets.isEmpty && (focusPath.isEmpty || exportFocusedModel)
  }

  private var allowsSavedCameras: Bool { source != .turntable && !exportFocusedModel && targets.isEmpty }

  private var isSavedCamera: Bool {
    if case .saved = camera { return true }
    return false
  }

  private func layoutOption(_ option: Layout) -> some View {
    let (width, height) = option.dimensions
    let aspect = CGFloat(width) / CGFloat(height)
    let selected = layout == option
    return VStack(spacing: 5) {
      RoundedRectangle(cornerRadius: 3)
        .strokeBorder(lineWidth: 1.5)
        .foregroundStyle(selected ? Color.accentColor : Color.secondary)
        .frame(width: min(39, 34 * aspect), height: min(34, 39 / aspect))
        .frame(height: 35)
      Text(option.rawValue).font(.callout.weight(.medium))
      Text(option.ratio).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity)
    .frame(height: 83)
    .background(selected ? Color.accentColor.opacity(0.10) : Color.primary.opacity(0.035), in: .rect(cornerRadius: 10))
    .overlay {
      RoundedRectangle(cornerRadius: 10)
        .strokeBorder(selected ? Color.accentColor : Color.primary.opacity(0.12), lineWidth: selected ? 1.5 : 1)
    }
    .contentShape(.rect(cornerRadius: 10))
  }

  private func activity(_ destination: URL, done: Int, total: Int, cancelling: Bool) -> some View {
    let phase = cancelling ? "Cancelling…" : total == 0 ? "Preparing Video…" : done == total ? "Finalizing Video…" : "Rendering Frames"
    return VStack(alignment: .leading, spacing: 10) {
      Text(phase).font(.headline)
      Text(destination.lastPathComponent).foregroundStyle(.secondary).lineLimit(1)
      if done > 0, done < total, !cancelling {
        ProgressView(value: Double(done), total: Double(total))
          .accessibilityLabel("Frames Rendered")
          .accessibilityValue("\(done) of \(total)")
        Text("Frame \(done) of \(total)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
          .accessibilityHidden(true)
      } else {
        ProgressView().progressViewStyle(.linear).accessibilityLabel(phase)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(24)
  }

  private func result(symbol: String, tint: Color, title: String, detail: String) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: symbol).font(.title2).foregroundStyle(tint).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 5) {
        Text(title).font(.headline)
        Text(detail).foregroundStyle(.secondary).textSelection(.enabled)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(24)
  }

  @ViewBuilder private var buttons: some View {
    HStack {
      switch state {
      case .settings:
        let (width, height) = resolution.size(for: layout)
        Text("\(width) × \(height) · MP4 (H.264)")
          .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
        Spacer()
        Button("Cancel", action: close).keyboardShortcut(.cancelAction)
        Button(targets.count > 1 ? "Choose Folder…" : "Continue…", action: chooseDestination).keyboardShortcut(.defaultAction)
          .disabled(choosingLocation)
      case .queued, .running:
        Spacer()
        Button("Cancel Export") {
          if let job { RenderQueue.shared.cancel(job) }
        }
        .keyboardShortcut(.cancelAction)
        Button("Continue in Background") {
          close()
          RenderQueueWindow.shared.showWindow(nil)
        }
        .keyboardShortcut(.defaultAction)
      case .cancelling:
        Spacer()
      case .complete(let destination):
        Spacer()
        Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([destination]) }
        Button("Done", action: close).keyboardShortcut(.defaultAction)
      case .failed:
        Spacer()
        Button("Close", action: close).keyboardShortcut(.cancelAction)
        Button("Back to Settings") { job = nil; startupError = nil }.keyboardShortcut(.defaultAction)
      }
    }
    .frame(minHeight: 23)
  }

  private func chooseDestination() {
    choosingLocation = true
    if targets.count > 1 {
      let panel = NSOpenPanel()
      panel.title = "Choose an Export Folder"
      panel.prompt = "Choose"
      panel.canChooseDirectories = true
      panel.canChooseFiles = false
      panel.canCreateDirectories = true
      presentSavePanel(panel) { response in
        choosingLocation = false
        guard response == .OK, let folder = panel.url else { return }
        let movies = targets.map { target in
          RenderQueue.BatchMovie(name: target.title + " – " + source.title,
                                 options: options(for: target.path), summary: exportSummary)
        }
        RenderQueue.shared.enqueueMovies(movies, project: snapshot(), library: library, in: folder)
        close()
        RenderQueueWindow.shared.showWindow(nil)
      }
      return
    }
    let panel = NSSavePanel()
    panel.allowedContentTypes = [.mpeg4Movie]
    let name = targets.first?.title ?? (exportFocusedModel ? focusedModel ?? title : title)
    panel.nameFieldStringValue = name + " – \(source.title).mp4"
    panel.prompt = "Export"
    presentSavePanel(panel) { response in
      choosingLocation = false
      guard response == .OK, let destination = panel.url else { return }
      start(destination)
    }
  }

  private var exportSummary: String { String(bmapp.movieSummary(choice(for: []))) }

  /// The sheet's settings as bmapp takes them; the camera is resolved against what this video allows.
  private func choice(for path: [String]) -> bmapp.MovieChoice {
    var choice = bmapp.MovieChoice()
    choice.source = source.engine
    choice.shape = layout.engine
    choice.resolution = resolution.engine
    choice.quality = quality.engine
    choice.fps = Int32(fps)
    choice.turntableSeconds = Int32(turntableSeconds)
    choice.snapAudio = includeSnapAudio
    choice.standardPreview = standardPreview
    choice.angles = angles
    switch camera {
    case .director: choice.camera = .Director
    case .track: choice.camera = allowsTrack ? .Track : .Director
    case .viewport: choice.camera = .Viewport
    case .saved(let id):
      choice.camera = allowsSavedCameras ? .Saved : .Director
      choice.sceneCameraId = std.string(id)
    }
    for model in path { choice.modelPath.push_back(std.string(model)) }
    if let stamp = VideoLogo.shared.stamp {
      choice.logo = std.string(stamp.file.path)
      choice.logoCorner = stamp.corner.engine
    }
    return choice
  }

  private func options(for path: [String]) -> [String] {
    bmapp.movieArguments(choice(for: path)).map { String($0) }
  }

  private func start(_ destination: URL) {
    // the project remembers which camera films its Build videos, as the web app does
    if targets.isEmpty && source != .turntable {
      switch camera {
      case .director: if allowsTrack { rememberCamera("automatic") }  // without keys, "track" films the same
      case .viewport: rememberCamera("buildView")
      case .track: rememberCamera("track")
      case .saved: break
      }
    }
    let path = targets.first?.path ?? (exportFocusedModel ? focusPath : [])
    do {
      job = try RenderQueue.shared.enqueue(snapshot(), operation: .video, options: options(for: path), library: library,
                                           destination: destination, summary: exportSummary)
    } catch {
      startupError = error.localizedDescription
    }
  }
}
