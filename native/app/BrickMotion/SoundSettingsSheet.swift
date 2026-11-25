import AppKit
import AVFoundation
import BMApp
import SwiftUI

struct SoundSettingsSheet: View {
  private struct Sample: @unchecked Sendable {
    let mix: bmapp.SnapMix
    let example: bmapp.SnapExample
    let recordings: String
  }

  @State private var mix: bmapp.SnapMix
  @State private var example: bmapp.SnapExample = .Brick
  @State private var player: AVAudioPlayer?
  @State private var previewID: UUID?
  @State private var previewError: String?
  @State private var showCharacter = false
  let apply: (bmapp.SnapMix) -> Bool
  let close: () -> Void

  nonisolated static var recordings: String {
    Bundle.main.resourceURL?.appendingPathComponent("SnapSounds", isDirectory: true).path ?? ""
  }

  init(mix: bmapp.SnapMix, apply: @escaping (bmapp.SnapMix) -> Bool, close: @escaping () -> Void) {
    _mix = State(initialValue: mix)
    self.apply = apply
    self.close = close
  }

  static func show(_ context: CommandContext) {
    guard let session = context.session, let window = context.window, window.attachedSheet == nil else { return }
    let sheet = NSWindow()
    let view = SoundSettingsSheet(mix: session.snapMix(), apply: { mix in
      context.perform { $0.setSnapMix(mix) }
    }, close: { [weak window, weak sheet] in
      if let sheet { window?.endSheet(sheet) }
    })
    sheet.contentViewController = NSHostingController(rootView: view)
    window.beginSheet(sheet)
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        Image(systemName: "waveform").font(.title2).foregroundStyle(.tint).accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 4) {
          Text("Snap Sound").font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
          Text("Mix the sound of parts seating in Build videos.")
            .font(.subheadline).foregroundStyle(.secondary)
        }
        Spacer()
      }
      .padding(.horizontal, 22).padding(.vertical, 18)
      Divider()
      Form {
        Section {
          Toggle("Include in Build Exports by Default", isOn: $mix.enabled)
          Picker("Source", selection: $mix.source) {
            Text("Part Physics").tag(bmapp.SnapSource.Physical)
            Text("Recorded").tag(bmapp.SnapSource.Recorded)
            Text("Synthesised").tag(bmapp.SnapSource.Synthesised)
          }
          if mix.source == .Recorded {
            Picker("Recordings", selection: $mix.library) {
              Text("All Recordings").tag(bmapp.SnapLibrary.All)
              Text("Freesound").tag(bmapp.SnapLibrary.Freesound)
              Text("OpenGameArt").tag(bmapp.SnapLibrary.OpenGameArt)
            }
          }
          LabeledContent("Preset") {
            Menu("Choose Preset") {
              preset("Part Physics", "physical")
              preset("Balanced", "balanced")
              preset("Product Video", "product")
              preset("Click Only", "click")
              preset("Soft", "soft")
              preset("Synthesised", "synth")
            }
            .fixedSize()
          }
        }
        Section("Mix") {
          slider("Volume", $mix.volume, 0...1.5, step: 0.05)
          slider("Room", $mix.room, 0...1, step: 0.05)
          slider("Stereo Width", $mix.stereo, 0...1, step: 0.05)
        }
        if mix.source != .Physical {
          DisclosureGroup("Click and Body", isExpanded: $showCharacter) {
            slider("Click Level", $mix.click, 0...2, step: 0.05)
            slider("Brightness", $mix.brightness, 500...6000, step: 100, hertz: true)
            slider("Click Pitch", $mix.pitch, 0.7...1.4, step: 0.01)
            slider("Body Level", $mix.thump, 0...2, step: 0.05)
            slider("Body Pitch", $mix.thumpPitch, 0.5...2, step: 0.05)
            slider("Body Length", $mix.thumpLength, 0.3...2, step: 0.05)
            slider("Variation", $mix.variation, 0...1, step: 0.05)
            Picker("Simultaneous Arrivals", selection: $mix.together) {
              ForEach(Int32(1)...Int32(3), id: \.self) { Text($0.formatted()).tag($0) }
            }
            Toggle("Match Pitch to Part Size", isOn: $mix.sizePitch)
            Toggle("Match Clicks to Part Size", isOn: $mix.sizeMatch)
          }
        }
      }
      .formStyle(.grouped)
      .frame(height: 392)
      Divider()
      HStack(spacing: 9) {
        Picker("Sample", selection: $example) {
          Text("Plate").tag(bmapp.SnapExample.Plate)
          Text("Brick").tag(bmapp.SnapExample.Brick)
          Text("Friction Pin").tag(bmapp.SnapExample.Pin)
        }
        .labelsHidden()
        .fixedSize()
        Button(action: preview) { Label("Play Sample", systemImage: "play.fill") }
          .disabled(previewID != nil)
        if previewID != nil { ProgressView().controlSize(.small).accessibilityLabel("Preparing sample") }
        Spacer()
        Button("Cancel", action: close).keyboardShortcut(.cancelAction)
        Button("Apply") { if apply(mix) { close() } }.keyboardShortcut(.defaultAction)
      }
      .padding(.horizontal, 20).padding(.vertical, 13)
      if let previewError {
        Text(previewError).font(.caption).foregroundStyle(.secondary).padding(.bottom, 12)
      }
    }
    .frame(width: 530)
    .onDisappear {
      previewID = nil
      player?.stop()
    }
  }

  private func slider(_ title: String, _ value: Binding<Double>, _ limits: ClosedRange<Double>,
                      step: Double, hertz: Bool = false) -> some View {
    let readout = hertz ? value.wrappedValue.formatted() + " Hz" :
      value.wrappedValue.formatted(.percent.precision(.fractionLength(0)))
    return LabeledContent(title) {
      HStack(spacing: 10) {
        Slider(value: value, in: limits, step: step).labelsHidden()
          .accessibilityLabel(title).accessibilityValue(readout)
        Text(readout).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
          .frame(width: 63, alignment: .trailing).accessibilityHidden(true)
      }
    }
  }

  private func preset(_ title: String, _ name: String) -> some View {
    Button(title) {
      let enabled = mix.enabled
      mix = bmapp.snapMixPreset(std.string(name))
      mix.enabled = enabled
    }
  }

  private func preview() {
    player?.stop()
    previewError = nil
    let id = UUID()
    previewID = id
    let sample = Sample(mix: mix, example: example, recordings: Self.recordings)
    Task { @MainActor in
      let data = await Task.detached(priority: .userInitiated) {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("BrickMotion-\(id).wav")
        defer { try? FileManager.default.removeItem(at: path) }
        guard bmapp.writeSnapPreview(sample.mix, sample.example, std.string(sample.recordings), std.string(path.path)) else {
          return nil as Data?
        }
        return try? Data(contentsOf: path)
      }.value
      guard previewID == id else { return }
      previewID = nil
      guard let data, let audio = try? AVAudioPlayer(data: data), audio.play() else {
        previewError = "The sample could not be played."
        return
      }
      player = audio
    }
  }
}
