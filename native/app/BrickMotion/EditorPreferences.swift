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
  /// The project's scene backdrop in the editor; off keeps the editor's own (exports keep the scene).
  var sceneBackdrop: Bool { didSet { save(sceneBackdrop, key: "viewportSceneBackdrop") } }
  var autoPlan: Bool { didSet { save(autoPlan, key: "autoPlanBuild") } }
  var selectionBar: Bool { didSet { save(selectionBar, key: "viewportSelectionBar") } }
  /// The project's snap sounds while the Build plays in the editor.
  var playSnapSounds: Bool { didSet { save(playSnapSounds, key: "playSnapSounds") } }

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    appearance = defaults.string(forKey: "editorAppearance").flatMap(Appearance.init(rawValue:)) ?? .system
    sceneBackdrop = defaults.object(forKey: "viewportSceneBackdrop") as? Bool ?? true
    autoPlan = defaults.object(forKey: "autoPlanBuild") as? Bool ?? true
    selectionBar = defaults.object(forKey: "viewportSelectionBar") as? Bool ?? true
    playSnapSounds = defaults.object(forKey: "playSnapSounds") as? Bool ?? true
  }

  var viewport: bmapp.ViewportPreferences {
    var preferences = bmapp.ViewportPreferences()
    preferences.autoPlan = autoPlan
    preferences.sceneBackdrop = sceneBackdrop
    return preferences
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
