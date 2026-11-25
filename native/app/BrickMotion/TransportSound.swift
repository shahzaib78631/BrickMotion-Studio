// Snap sounds while the Build plays: the track the Build video exports (the project's mix), made
// when playback starts and held in step with the playhead, its speed and its loop.
import AVFoundation
import BMApp

@MainActor final class TransportSound {
  private var player: AVAudioPlayer?
  /// The session revision and plan the track was made for; a new one is made on the next play.
  private var made: (session: UInt64, plan: UInt64)?
  private(set) var failure = ""

  /// Called on every drawn frame of the Build tab.
  func follow(_ state: bmapp.PlaybackState, rate: Double, viewport: ViewportView) {
    guard EditorPreferences.shared.playSnapSounds, state.playing, state.plan == .Ready,
          let session = viewport.document?.session, session.snapMix().enabled else { return pause() }
    let revision = (session: session.version(), plan: state.version)
    if made.map({ $0 != revision }) ?? true {
      player?.stop()
      player = nil
      made = revision
      failure = ""
      let file = FileManager.default.temporaryDirectory.appendingPathComponent("BrickMotion-Snaps-\(UUID().uuidString).wav")
      defer { try? FileManager.default.removeItem(at: file) }
      let error = String(viewport.viewport.writeSnapTrack(std.string(file.path), std.string(SoundSettingsSheet.recordings)))
      guard error.isEmpty, let data = try? Data(contentsOf: file), let audio = try? AVAudioPlayer(data: data) else {
        failure = error.isEmpty ? "The snap sounds could not be played." : error
        return
      }
      audio.enableRate = true
      audio.prepareToPlay()
      player = audio
    }
    guard let player else { return }
    if player.rate != Float(rate) { player.rate = Float(rate) }
    // Seeks, loops and drift: the playhead leads, the sound follows.
    if !player.isPlaying || abs(player.currentTime - state.seconds) > 0.08 {
      guard state.seconds < player.duration else { return pause() }
      player.currentTime = max(0, state.seconds)
      player.play()
    }
  }

  func pause() {
    if player?.isPlaying == true { player?.pause() }
  }
}
