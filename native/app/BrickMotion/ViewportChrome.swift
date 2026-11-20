import AppKit
import BMApp
import Observation
import SwiftUI

@MainActor @Observable final class ViewportPresentation {
  @ObservationIgnored weak var view: ViewportView?
  private(set) var zoom = 100
  private(set) var name = "Perspective"
  private(set) var yaw = 0.0
  private(set) var pitch = 0.0
  private(set) var distance = 400.0
  private(set) var fieldOfView = 34.4
  private(set) var target = bmapp.Vec3()
  var orthographic = false {
    didSet { view?.viewport.setOrthographic(orthographic); view?.changed() }
  }
  var style: bmapp.ViewStyle = .Shaded {
    didSet { view?.viewport.setViewStyle(style); view?.changed() }
  }
  var grid: Double = 0 {
    didSet { view?.viewport.setGridSpacing(grid); view?.changed() }
  }

  func update() {
    guard let view else { return }
    let camera = view.viewport.camera()
    let percent = Int(min(100000, max(1, view.viewport.zoomPercent())).rounded())
    if percent != zoom { zoom = percent }
    if abs(camera.yaw - yaw) > 0.005 { yaw = camera.yaw }
    if abs(camera.pitch - pitch) > 0.005 { pitch = camera.pitch }
    if abs(camera.distance - distance) > 0.05 { distance = camera.distance }
    let angle = camera.verticalFOV * 180 / .pi
    if abs(angle - fieldOfView) > 0.01 { fieldOfView = angle }
    if target.x != camera.target.x || target.y != camera.target.y || target.z != camera.target.z {
      target = camera.target
    }
    let newName = Self.name(camera)
    if newName != name { name = newName }
  }

  func preset(_ preset: bmapp.ViewPreset) {
    view?.viewport.view(preset)
    view?.changed()
  }

  func rotate(_ degrees: Double) { view?.viewport.rotateGesture(degrees); view?.changed() }
  func scale(_ factor: Double) { view?.viewport.zoom(factor); view?.changed() }
  func fit() { view?.fitAll(nil) }

  func flatLay() {
    orthographic = true
    view?.animation?.arrange(step: -1, mode: .LaidOut)
    preset(.Top)
  }

  func center() { view?.viewport.centerOnFloor(); view?.changed() }

  private static func name(_ camera: bmapp.CameraState) -> String {
    if camera.pitch > 1.5 { return "Top" }
    if camera.pitch < -1.5 { return "Bottom" }
    if abs(camera.pitch) < 0.005 {
      let facing = camera.yaw.remainder(dividingBy: .pi * 2)
      if abs(facing) < 0.005 { return "Front" }
      if abs(abs(facing) - .pi) < 0.005 { return "Back" }
      if abs(facing - .pi / 2) < 0.005 { return "Left" }
      if abs(facing + .pi / 2) < 0.005 { return "Right" }
    }
    return camera.orthographic ? "Parallel" : "Perspective"
  }
}

struct ViewportChrome: View {
  @Bindable var camera: ViewportPresentation
  let model: DocumentModel

  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 5) {
        options
        Divider().frame(height: 15)
        zoom
      }
      options
    }
    .padding(.horizontal, 7)
    .padding(.vertical, 4)
    .glassEffect(.regular, in: .capsule)
    .overlay { Capsule().strokeBorder(.primary.opacity(0.1), lineWidth: 0.5).allowsHitTesting(false) }
    .fixedSize(horizontal: true, vertical: true)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Viewport navigation")
  }

  private var options: some View {
    Menu {
      Button("Front") { camera.preset(.Front) }
      Button("Back") { camera.preset(.Back) }
      Button("Left") { camera.preset(.Left) }
      Button("Right") { camera.preset(.Right) }
      Button("Top") { camera.preset(.Top) }
      Button("Bottom") { camera.preset(.Bottom) }
      Divider()
      Button("Orbit 45° Left") { camera.rotate(-45) }
      Button("Orbit 45° Right") { camera.rotate(45) }
      Button("Frame Model") { camera.fit() }
      Button("Centre on Floor") { camera.center() }
      Button("Flat Lay") { camera.flatLay() }
      Divider()
      Toggle("Orthographic Projection", isOn: $camera.orthographic)
      Picker("Display", selection: $camera.style) {
        Text("Shaded").tag(bmapp.ViewStyle.Shaded)
        Text("Clay").tag(bmapp.ViewStyle.Clay)
        Text("Wireframe").tag(bmapp.ViewStyle.Wireframe)
      }
      Button("Path-Traced Preview…") { StillExport.preview(model.context) }
        .disabled(model.snapshot.pieces == 0)
      Picker("Grid Spacing", selection: $camera.grid) {
        Text("Off").tag(0.0)
        Text("1 Stud").tag(20.0)
        Text("2 Studs").tag(40.0)
        Text("5 Studs").tag(100.0)
        Text("10 Studs").tag(200.0)
      }
      if let window = model.viewport?.window {
        Button("Toggle Full Screen") { window.toggleFullScreen(nil) }
      }
    } label: {
      HStack(spacing: 4) {
        NavigationGlyph(yaw: camera.yaw, pitch: camera.pitch)
          .frame(width: 16, height: 16)
          .accessibilityHidden(true)
        Text(camera.name).font(.callout.weight(.medium)).lineLimit(1)
        Image(systemName: "chevron.down").font(.system(size: 7, weight: .semibold))
          .foregroundStyle(.secondary)
      }
      .padding(.horizontal, 4)
      .frame(height: 24)
    }
    .menuStyle(.borderlessButton)
    .menuIndicator(.hidden)
    .fixedSize()
    .accessibilityLabel("View Options")
    .accessibilityValue(camera.name)
  }

  private var zoom: some View {
    HStack(spacing: 0) {
      zoomButton("Zoom Out", image: "minus") { camera.scale(1 / 1.2) }
      Button {
        camera.fit()
      } label: {
        Text("\(camera.zoom)%").font(.caption.monospacedDigit()).frame(minWidth: 38, minHeight: 24)
      }
      .buttonStyle(.borderless)
      .help("Frame Model")
      .accessibilityLabel("Frame Model")
      .accessibilityValue("\(camera.zoom) percent")
      zoomButton("Zoom In", image: "plus") { camera.scale(1.2) }
    }
  }

  private func zoomButton(_ name: String, image: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: image).font(.system(size: 9, weight: .semibold)).frame(width: 22, height: 24)
    }
    .buttonStyle(.borderless).help(name).accessibilityLabel(name)
  }
}

private struct NavigationGlyph: View {
  let yaw, pitch: Double

  var body: some View {
    Canvas { context, size in
      let middle = CGPoint(x: size.width / 2, y: size.height / 2)
      let axes: [(CGPoint, Color)] = [
        (CGPoint(x: cos(yaw), y: sin(yaw) * sin(pitch)), .red),
        (CGPoint(x: 0, y: -cos(pitch)), .green),
        (CGPoint(x: -sin(yaw), y: cos(yaw) * sin(pitch)), .blue)
      ]
      for (point, color) in axes {
        let end = CGPoint(x: middle.x + point.x * 6, y: middle.y + point.y * 6)
        var path = Path()
        path.move(to: middle)
        path.addLine(to: end)
        context.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: 1.4, lineCap: .round))
        context.fill(Path(ellipseIn: CGRect(x: end.x - 1.3, y: end.y - 1.3, width: 2.6, height: 2.6)),
                     with: .color(color))
      }
    }
  }
}

struct ViewportStatus: View {
  let model: DocumentModel

  var body: some View {
    let planning = !model.animation.visible && model.animation.state.plan == .Planning
    HStack(spacing: 7) {
      if planning {
        ProgressView().controlSize(.mini).accessibilityHidden(true)
        Text("Planning Build")
      }
      if model.snapshot.hidden > 0 {
        Button {
          model.viewport?.showAllPieces(nil)
        } label: {
          Label("\(model.snapshot.hidden) hidden", systemImage: "eye.slash")
        }
        .buttonStyle(.borderless)
        .help("Show Hidden Parts")
      }
      if model.animation.stepPreview == .LaidOut, model.animation.focusedStep == nil {
        Button(action: model.animation.rest) {
          Label("Laid Out", systemImage: "square.grid.3x3")
        }
        .buttonStyle(.borderless)
        .help("Restore assembled model")
      }
    }
    .font(.caption)
    .padding(planning || model.snapshot.hidden > 0 || model.animation.stepPreview == .LaidOut ? 7 : 0)
    .glassEffect(in: .capsule)
    .fixedSize()
  }
}
