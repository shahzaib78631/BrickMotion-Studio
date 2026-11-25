import AppKit
import BMApp
import SwiftUI
import UniformTypeIdentifiers

/// File → Export Still: a path-traced picture in a video frame shape, or a cover for social
/// posts (the vertical and square shapes), rendered in the background by the queue.
@MainActor struct StillExportSheet: View {
  typealias Layout = VideoExportSheet.Layout

  enum Size: CaseIterable, Identifiable {
    case standard, large
    var id: Self { self }
    func pixels(_ layout: Layout) -> (Int, Int) {
      let (width, height) = layout.dimensions
      return self == .standard ? (width, height) : (width * 2, height * 2)
    }
  }

  enum Quality: Int, CaseIterable, Identifiable {
    case draft = 32, standard = 128, final = 512
    var id: Self { self }
    var title: String {
      switch self {
      case .draft: "Draft"
      case .standard: "Standard"
      case .final: "Final"
      }
    }
  }

  enum Camera: Hashable { case viewport, automatic }

  let title: String
  let angles: [String]
  let snapshot: () -> Data
  let library: String
  let presentSavePanel: (NSSavePanel, @escaping (NSApplication.ModalResponse) -> Void) -> Void
  let close: () -> Void

  @State private var layout: Layout = .landscape
  @State private var size: Size = .standard
  @State private var quality: Quality = .standard
  @State private var camera: Camera
  @State private var showLogo: Bool
  @State private var error: String?

  /// The project's look as the path tracer takes it: the scene's backdrop and the light rig.
  private var lookArguments: [String] = []

  init(title: String, angles: [String], look: [String] = [], snapshot: @escaping () -> Data, library: String,
       presentSavePanel: @escaping (NSSavePanel, @escaping (NSApplication.ModalResponse) -> Void) -> Void,
       close: @escaping () -> Void) {
    self.title = title
    self.angles = angles
    self.lookArguments = look
    self.snapshot = snapshot
    self.library = library
    self.presentSavePanel = presentSavePanel
    self.close = close
    _camera = State(initialValue: angles.isEmpty ? .automatic : .viewport)
    _showLogo = State(initialValue: VideoLogo.shared.stamp != nil)
  }

  /// bmexport's path tracer draws its own floor and no edge lines; the scene's backdrop and
  /// whether the lights turn with the camera carry over.
  static func lookArguments(_ look: bmapp.RenderLook) -> [String] {
    var arguments = [look.lightsFollowCamera ? "--lights-follow" : "--lights-fixed"]
    if let scene = bmapp.Session.scenes().first(where: { String($0.id) == String(look.scene) }) {
      let byte = { (value: Double) in String(Int((value * 255).rounded())) }
      arguments += ["--background", [scene.background.x, scene.background.y, scene.background.z].map(byte).joined(separator: ",")]
    }
    return arguments
  }

  static func show(_ context: CommandContext) {
    guard let document = context.document, let window = context.window, window.attachedSheet == nil else { return }
    var angles: [String] = []
    if let pose = context.viewport?.viewport.camera() {
      let degrees = 180 / Double.pi
      angles = ["--azimuth", String(pose.yaw * degrees), "--elevation", String(pose.pitch * degrees),
                "--fov", String(pose.verticalFOV * degrees)]
    }
    let sheet = NSWindow()
    let view = StillExportSheet(
      title: (document.displayName as NSString).deletingPathExtension, angles: angles,
      look: Self.lookArguments(document.session.renderLook()),
      snapshot: { Data(String(document.session.projectBytes()).utf8) },
      library: String(bmapp.Session.ldrawDirectory()),
      presentSavePanel: { [weak sheet] panel, completion in
        guard let sheet else { return completion(.cancel) }
        panel.beginSheetModal(for: sheet, completionHandler: completion)
      },
      close: { [weak window, weak sheet] in if let sheet { window?.endSheet(sheet) } })
    sheet.contentViewController = NSHostingController(rootView: view)
    window.beginSheet(sheet)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 13) {
        Image(systemName: "photo")
          .font(.system(size: 22, weight: .medium))
          .foregroundStyle(Color.accentColor)
          .frame(width: 44, height: 44)
          .background(Color.accentColor.opacity(0.11), in: .rect(cornerRadius: 11))
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 3) {
          Text("Export Still").font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
          Text(title).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
        }
        Spacer()
      }
      .padding(.horizontal, 24).padding(.top, 22).padding(.bottom, 18)
      Divider()
      VStack(alignment: .leading, spacing: 14) {
        HStack(spacing: 8) {
          ForEach(Layout.allCases) { option in
            Button { layout = option } label: { shape(option) }
              .buttonStyle(.plain)
              .accessibilityLabel("\(option.rawValue), \(option.ratio)")
              .accessibilityAddTraits(layout == option ? [.isSelected] : [])
          }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Frame Shape")
        Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 12) {
          GridRow {
            Text("Size").accessibilityHidden(true)
            Picker("Size", selection: $size) {
              ForEach(Size.allCases) { option in
                let (width, height) = option.pixels(layout)
                Text("\(width) × \(height)").tag(option)
              }
            }
            .labelsHidden().fixedSize()
          }
          GridRow {
            Text("Quality").accessibilityHidden(true)
            Picker("Quality", selection: $quality) {
              ForEach(Quality.allCases) { Text("\($0.title) · \($0.rawValue) samples").tag($0) }
            }
            .labelsHidden().fixedSize()
          }
          GridRow {
            Text("Camera").accessibilityHidden(true)
            Picker("Camera", selection: $camera) {
              Text("Viewport Angle").tag(Camera.viewport).disabled(angles.isEmpty)
              Text("Automatic Framing").tag(Camera.automatic)
            }
            .labelsHidden().fixedSize()
          }
          if VideoLogo.shared.file != nil {
            GridRow {
              Text("Logo").accessibilityHidden(true)
              Toggle("Show the Video Logo", isOn: $showLogo)
            }
          }
        }
        Text(layout == .vertical || layout == .square || layout == .portrait
             ? "Vertical, portrait and square shapes make covers for social posts."
             : "Path traced in the background. The Render Queue shows its progress.")
          .font(.caption).foregroundStyle(.secondary)
        if let error {
          Label(error, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
        }
      }
      .padding(.horizontal, 24).padding(.vertical, 20)
      Divider()
      HStack {
        let (width, height) = size.pixels(layout)
        Text("\(width) × \(height) · PNG").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
        Spacer()
        Button("Cancel", action: close).keyboardShortcut(.cancelAction)
        Button("Continue…", action: chooseDestination).keyboardShortcut(.defaultAction)
      }
      .padding(.horizontal, 24).padding(.vertical, 15)
    }
    .frame(width: 520)
  }

  private func shape(_ option: Layout) -> some View {
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
    .frame(maxWidth: .infinity).frame(height: 83)
    .background(selected ? Color.accentColor.opacity(0.10) : Color.primary.opacity(0.035), in: .rect(cornerRadius: 10))
    .overlay {
      RoundedRectangle(cornerRadius: 10)
        .strokeBorder(selected ? Color.accentColor : Color.primary.opacity(0.12), lineWidth: selected ? 1.5 : 1)
    }
    .contentShape(.rect(cornerRadius: 10))
  }

  /// The helper's arguments for these settings.
  var options: [String] {
    let (width, height) = size.pixels(layout)
    var arguments = ["--size", "\(width)x\(height)", "--samples", String(quality.rawValue), "--no-denoise"]
    if camera == .viewport { arguments += angles }
    return arguments + lookArguments
  }

  private func chooseDestination() {
    let panel = NSSavePanel()
    panel.allowedContentTypes = [.png]
    panel.nameFieldStringValue = "\(title) – \(layout.rawValue).png"
    panel.prompt = "Export"
    presentSavePanel(panel) { response in
      guard response == .OK, let destination = panel.url else { return }
      submit(to: destination)
    }
  }

  private func submit(to destination: URL) {
    let (width, height) = size.pixels(layout)
    let stamp: VideoLogo.Stamp? = showLogo ? VideoLogo.shared.stamp : nil
    var finish: (@Sendable (URL) throws -> Void)?
    if let stamp { finish = { url in try stamp.apply(to: url) } }
    let summary = "Still · \(width) × \(height) · \(quality.title)" + (stamp == nil ? "" : " · Logo")
    do {
        _ = try RenderQueue.shared.enqueue(snapshot(), operation: .still, options: options, library: library,
                                           destination: destination, summary: summary, finish: finish)
        close()
        RenderQueueWindow.shared.showWindow(nil)
    } catch {
      self.error = error.localizedDescription
    }
  }
}
