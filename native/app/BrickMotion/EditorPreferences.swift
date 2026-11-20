import AppKit
import BMApp
import Observation

@MainActor @Observable final class EditorPreferences {
  enum Appearance: String, CaseIterable {
    case system = "System", light = "Light", dark = "Dark"
  }

  static let shared = EditorPreferences()
  static let didChange = Notification.Name("BMEditorPreferencesDidChange")

  @ObservationIgnored private let defaults: UserDefaults
  var appearance: Appearance {
    didSet {
      defaults.set(appearance.rawValue, forKey: "editorAppearance")
      applyAppearance()
    }
  }
  var edges: Bool { didSet { save(edges, key: "viewportEdges") } }
  var floor: Bool { didSet { save(floor, key: "viewportFloor") } }
  var shadows: Bool { didSet { save(shadows, key: "viewportShadows") } }
  var ambientOcclusion: Bool { didSet { save(ambientOcclusion, key: "viewportAmbientOcclusion") } }
  var autoPlan: Bool { didSet { save(autoPlan, key: "autoPlanBuild") } }
  var selectionBar: Bool { didSet { save(selectionBar, key: "viewportSelectionBar") } }

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    appearance = defaults.string(forKey: "editorAppearance").flatMap(Appearance.init(rawValue:)) ?? .system
    edges = defaults.object(forKey: "viewportEdges") as? Bool ?? true
    floor = defaults.object(forKey: "viewportFloor") as? Bool ?? true
    shadows = defaults.object(forKey: "viewportShadows") as? Bool ?? true
    ambientOcclusion = defaults.object(forKey: "viewportAmbientOcclusion") as? Bool ?? true
    autoPlan = defaults.object(forKey: "autoPlanBuild") as? Bool ?? true
    selectionBar = defaults.object(forKey: "viewportSelectionBar") as? Bool ?? true
  }

  var viewport: bmapp.ViewportPreferences {
    .init(edges: edges, floor: floor, shadows: shadows, ambientOcclusion: ambientOcclusion, autoPlan: autoPlan)
  }

  func applyAppearance() {
    switch appearance {
    case .system: NSApp.appearance = nil
    case .light: NSApp.appearance = NSAppearance(named: .aqua)
    case .dark: NSApp.appearance = NSAppearance(named: .darkAqua)
    }
  }

  private func save(_ value: Bool, key: String) {
    defaults.set(value, forKey: key)
    NotificationCenter.default.post(name: Self.didChange, object: self)
  }
}
