// The project's look: scene backdrop, shading and the picture's details. Saved with the project
// (each change one named undo step) and used by every video; stills take the scene and lights.
import AppKit
import BMApp
import SwiftUI

extension bmapp.Shading: @retroactive CaseIterable {
  public static var allCases: [bmapp.Shading] { [.Standard, .Studio, .Neural, .HybridRT, .ScreenSpaceGI, .PathTraced, .RealTimePathTraced] }

  var title: String {
    switch self {
    case .Standard: "Standard"
    case .Studio: "Studio"
    case .Neural: "Neural"
    case .HybridRT: "Hybrid Ray Tracing"
    case .ScreenSpaceGI: "Screen-Space Bounce"
    case .PathTraced: "Path Traced"
    case .RealTimePathTraced: "Live Path Traced"
    @unknown default: "Standard"
    }
  }

  var caption: String {
    switch self {
    case .Standard: "Fast raster shading with shadows and occlusion"
    case .Studio: "Studio ABS plastic with baked world light, no edge lines"
    case .Neural: "Learned shader for soft studio light, in real time"
    case .HybridRT: "Hardware ray-traced glass and reflections over raster"
    case .ScreenSpaceGI: "Coloured bounce light and glossy reflections"
    case .PathTraced: "Final-render quality, refined while the view is still"
    case .RealTimePathTraced: "Real-time ReSTIR + SHaRC path tracing with SVGF denoising, always live"
    @unknown default: ""
    }
  }

  var symbol: String {
    switch self {
    case .Standard: "cube"
    case .Studio: "light.panel"
    case .Neural: "brain"
    case .HybridRT: "rays"
    case .ScreenSpaceGI: "sun.haze"
    case .PathTraced: "camera.aperture"
    case .RealTimePathTraced: "sparkles"
    @unknown default: "cube"
    }
  }
}

/// Reads and writes the look through the document, so undo, autosave and export see one value.
@MainActor struct LookEditor {
  let model: DocumentModel

  var look: bmapp.RenderLook {
    _ = model.snapshot.version  // observed: undo and redo refresh the panel
    return model.document.session.renderLook()
  }

  func change(_ edit: (inout bmapp.RenderLook) -> Void) {
    var next = look
    edit(&next)
    model.context.perform { $0.setRenderLook(next) }
  }

  func binding<Value: Equatable>(_ path: WritableKeyPath<bmapp.RenderLook, Value>) -> Binding<Value> {
    Binding(get: { look[keyPath: path] }, set: { value in
      guard look[keyPath: path] != value else { return }
      change { $0[keyPath: path] = value }
    })
  }
}

struct LookPanel: View {
  let model: DocumentModel
  /// The popover drops the header that the inspector tab gives its own.
  var compact = false

  private var editor: LookEditor { LookEditor(model: model) }
  private static let scenes = Array(bmapp.Session.scenes())

  var body: some View {
    let look = editor.look
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        if compact {
          VStack(alignment: .leading, spacing: 2) {
            Text("Look").font(.headline).accessibilityAddTraits(.isHeader)
            Text("Saved with the project and used by every video.").font(.caption).foregroundStyle(.secondary)
          }
        }
        sceneSection(look)
        shadingSection(look)
        detailSection(look)
      }
      .padding(compact ? 14 : 12)
    }
    .scrollBounceBehavior(.basedOnSize)
  }

  // MARK: Scene

  private func sceneSection(_ look: bmapp.RenderLook) -> some View {
    let current = Self.scenes.first { String($0.id) == String(look.scene) }
    return VStack(alignment: .leading, spacing: 8) {
      header("Scene", value: current.map { String($0.label) } ?? "Editor")
      LazyVGrid(columns: Array(repeating: GridItem(.fixed(28), spacing: 7), count: 7), alignment: .leading, spacing: 7) {
        SceneSwatch(color: nil, selected: current == nil, title: "Editor",
                    hint: "The editor's own backdrop, which follows Light and Dark appearance") {
          pick(scene: nil)
        }
        ForEach(Self.scenes, id: \.identifier) { scene in
          SceneSwatch(color: scene.color, selected: current?.identifier == scene.identifier,
                      title: String(scene.label), hint: String(scene.hint)) {
            pick(scene: scene)
          }
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Scene")
      if let current {
        Text(String(current.hint)).font(.caption).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  /// A scene brings its own floor (Black stage and Green screen have none).
  private func pick(scene: bmapp.ScenePreset?) {
    editor.change { look in
      look.scene = std.string(scene.map { String($0.id) } ?? "")
      look.floor = scene?.floor ?? true
    }
  }

  // MARK: Shading

  private func shadingSection(_ look: bmapp.RenderLook) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      header("Shading", value: look.shading.title)
      VStack(spacing: 2) {
        ForEach(bmapp.Shading.allCases, id: \.self) { shading in
          ShadingRow(shading: shading, selected: look.shading == shading) {
            editor.change { $0.shading = shading }
          }
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Shading")
      if look.shading == .PathTraced || look.shading == .RealTimePathTraced {
        Stepper(value: editor.binding(\.pathSamples), in: 8...1024, step: look.pathSamples >= 256 ? 64 : 8) {
          LabeledContent("Samples", value: "\(look.pathSamples)").monospacedDigit()
        }
        .help("Samples a pixel: the viewport refines to this many while still; every video frame is drawn with them")
        .padding(.leading, 34)
      }
      if look.shading == .Studio {
        Toggle("Baked studio visibility", isOn: editor.binding(\.worldGiOcclusion))
          .help("Studio's world light keeps its baked occlusion")
          .padding(.leading, 34)
      }
    }
  }

  // MARK: Details

  private func detailSection(_ look: bmapp.RenderLook) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      header("Details", value: nil)
      VStack(alignment: .leading, spacing: 7) {
        Toggle("Edge lines", isOn: editor.binding(\.edges))
          .disabled(look.shading == .Studio)
          .help(look.shading == .Studio ? "Studio shading draws lineless bricks" : "The LDraw outlines on every part")
        Toggle("Shadows", isOn: editor.binding(\.shadows))
        Toggle("Ambient occlusion", isOn: editor.binding(\.ambientOcclusion))
        Toggle("Floor", isOn: editor.binding(\.floor))
        Toggle(isOn: editor.binding(\.raytracedGlass)) {
          VStack(alignment: .leading, spacing: 1) {
            Text("Ray-traced glass")
            Text("Drawn when the view is still").font(.caption).foregroundStyle(.secondary)
          }
        }
        .help("Light refracts through every wall and cavity of transparent parts. Many times slower than the preview glass.")
        Toggle("Lights follow the camera", isOn: editor.binding(\.lightsFollowCamera))
          .help("Off: the light rig stays fixed to the model, as in EyeSight")
      }
      .toggleStyle(.checkbox)
    }
  }

  private func header(_ title: String, value: String?) -> some View {
    HStack(alignment: .firstTextBaseline) {
      Text(title).font(.subheadline.weight(.semibold)).accessibilityAddTraits(.isHeader)
      Spacer()
      if let value { Text(value).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
    }
  }
}

extension bmapp.ScenePreset {
  var identifier: String { String(id) }
  var color: Color { Color(.sRGB, red: background.x, green: background.y, blue: background.z) }
}

private struct SceneSwatch: View {
  let color: Color?
  let selected: Bool
  let title, hint: String
  let action: () -> Void
  @State private var hovered = false

  var body: some View {
    Button(action: action) {
      ZStack {
        if let color {
          RoundedRectangle(cornerRadius: 6).fill(color)
        } else {
          // The editor's backdrop: half light, half dark, as it follows the appearance.
          RoundedRectangle(cornerRadius: 6).fill(Color(white: 0.96))
            .overlay(alignment: .trailing) {
              UnevenRoundedRectangle(bottomTrailingRadius: 6, topTrailingRadius: 6).fill(Color(white: 0.11)).frame(width: 14)
            }
        }
        RoundedRectangle(cornerRadius: 6).strokeBorder(.primary.opacity(hovered ? 0.35 : 0.16), lineWidth: 0.5)
      }
      .frame(width: 28, height: 28)
      .padding(2)
      .overlay {
        if selected { RoundedRectangle(cornerRadius: 8).strokeBorder(Color.accentColor, lineWidth: 2) }
      }
      .contentShape(.rect(cornerRadius: 8))
    }
    .buttonStyle(.plain)
    .onHover { hovered = $0 }
    .help("\(title): \(hint)")
    .accessibilityLabel(title)
    .accessibilityHint(hint)
    .accessibilityAddTraits(selected ? [.isSelected] : [])
  }
}

private struct ShadingRow: View {
  let shading: bmapp.Shading
  let selected: Bool
  let action: () -> Void
  @State private var hovered = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        Image(systemName: shading.symbol)
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(selected ? Color.accentColor : .secondary)
          .frame(width: 24, height: 24)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 1) {
          Text(shading.title).font(.callout.weight(selected ? .semibold : .regular))
          Text(shading.caption).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
        if selected {
          Image(systemName: "checkmark").font(.caption.weight(.bold)).foregroundStyle(Color.accentColor)
            .accessibilityHidden(true)
        }
      }
      .padding(.horizontal, 6)
      .padding(.vertical, 5)
      .background(selected ? Color.accentColor.opacity(0.10) : hovered ? Color.primary.opacity(0.05) : .clear,
                  in: .rect(cornerRadius: 7))
      .contentShape(.rect(cornerRadius: 7))
    }
    .buttonStyle(.plain)
    .onHover { hovered = $0 }
    .accessibilityLabel(shading.title)
    .accessibilityHint(shading.caption)
    .accessibilityAddTraits(selected ? [.isSelected] : [])
  }
}
