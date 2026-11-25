// View → Record Viewport: what the viewport shows, 30 times a second, as an H.264 movie. The
// first frame sets the movie's size; later frames are fitted into it if the window is resized.
// The movie is written to a temporary file and saved where the person chooses when it stops.
import AppKit
import AVFoundation
import BMApp
import Observation

@MainActor @Observable final class ViewportRecorder {
  static let framesPerSecond = 30
  /// Longest side of the movie in pixels: keeps 5K displays within what the encoder takes.
  static let largestSide = 3840

  private(set) var recording = false
  private(set) var seconds = 0.0
  private(set) var frames = 0

  @ObservationIgnored private var writer: AVAssetWriter?
  @ObservationIgnored private var input: AVAssetWriterInput?
  @ObservationIgnored private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
  @ObservationIgnored private var timer: Timer?
  @ObservationIgnored private var started = Date()
  @ObservationIgnored private var file: URL?
  @ObservationIgnored private var size = CGSize.zero
  @ObservationIgnored private weak var view: ViewportView?
  /// The pane self-test: the finished movie is moved here, no save panel, and `saved` is called.
  @ObservationIgnored var testDestination: URL?
  @ObservationIgnored var saved: ((Bool) -> Void)?

  /// Starts recording `view`; false, with a beep, when the movie could not be started.
  @discardableResult func start(_ view: ViewportView) -> Bool {
    guard !recording else { return false }
    let first = view.viewport.capture()
    view.changed()
    guard let image = first.cgImage else { NSSound.beep(); return false }
    let scale = min(1, Double(Self.largestSide) / Double(max(image.width, image.height)))
    size = CGSize(width: even(Double(image.width) * scale), height: even(Double(image.height) * scale))
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("Viewport-\(UUID().uuidString).mp4")
    guard let writer = try? AVAssetWriter(outputURL: file, fileType: .mp4) else { NSSound.beep(); return false }
    let bits = max(4_000_000, Int(size.width * size.height * Double(Self.framesPerSecond) * 0.15))
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: size.width, AVVideoHeightKey: size.height,
      AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: bits, AVVideoExpectedSourceFrameRateKey: Self.framesPerSecond],
    ])
    input.expectsMediaDataInRealTime = true
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
      kCVPixelBufferWidthKey as String: Int(size.width), kCVPixelBufferHeightKey as String: Int(size.height),
    ])
    guard writer.canAdd(input) else { NSSound.beep(); return false }
    writer.add(input)
    guard writer.startWriting() else { NSSound.beep(); return false }
    writer.startSession(atSourceTime: .zero)
    (self.writer, self.input, self.adaptor, self.file, self.view) = (writer, input, adaptor, file, view)
    started = Date()
    seconds = 0
    frames = 0
    recording = true
    append(image, at: 0)
    let timer = Timer(timeInterval: 1 / Double(Self.framesPerSecond), repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.tick() }
    }
    RunLoop.main.add(timer, forMode: .common)  // keeps recording while a menu or a drag tracks
    self.timer = timer
    return true
  }

  /// Stops and asks where to save the movie; Cancel discards it.
  func stop(in window: NSWindow?, name: String) {
    guard recording, let writer, let input, let file else { return }
    timer?.invalidate()
    timer = nil
    recording = false
    input.markAsFinished()
    let length = seconds
    writer.endSession(atSourceTime: CMTime(seconds: length, preferredTimescale: 600))
    self.writer = nil
    self.input = nil
    self.adaptor = nil
    nonisolated(unsafe) let finishing = writer  // touched again only after it has finished
    finishing.finishWriting { [weak self] in
      Task { @MainActor in self?.save(file, failed: finishing.status != .completed, in: window, name: name) }
    }
  }

  private func save(_ file: URL, failed: Bool, in window: NSWindow?, name: String) {
    guard !failed else {
      try? FileManager.default.removeItem(at: file)
      if testDestination != nil { saved?(false); return }
      let alert = NSAlert()
      alert.messageText = "The Recording Couldn’t Be Saved"
      alert.informativeText = "The movie encoder stopped. Try a smaller window."
      return window.map { alert.beginSheetModal(for: $0) } ?? { alert.runModal() }()
    }
    if let destination = testDestination {
      let moved = (try? FileManager.default.moveItem(at: file, to: destination)) != nil
      saved?(moved)
      return
    }
    let panel = NSSavePanel()
    panel.allowedContentTypes = [.mpeg4Movie]
    panel.nameFieldStringValue = "\(name) Viewport.mp4"
    panel.message = "Save the viewport recording"
    let finish: (NSApplication.ModalResponse) -> Void = { response in
      defer { try? FileManager.default.removeItem(at: file) }
      guard response == .OK, let destination = panel.url else { return }
      do {
        if FileManager.default.fileExists(atPath: destination.path) {
          _ = try FileManager.default.replaceItemAt(destination, withItemAt: file)
        } else {
          try FileManager.default.moveItem(at: file, to: destination)
        }
        NSWorkspace.shared.activateFileViewerSelecting([destination])
      } catch {
        NSAlert(error: error).runModal()
      }
    }
    if let window { panel.beginSheetModal(for: window, completionHandler: finish) } else { finish(panel.runModal()) }
  }

  private func tick() {
    guard recording, let view, view.window != nil else {
      if recording { stop(in: nil, name: "BrickMotion") }
      return
    }
    let now = Date().timeIntervalSince(started)
    // The encoder is behind: drop this frame rather than stall the editor.
    guard input?.isReadyForMoreMediaData == true else { return }
    let picture = view.viewport.capture()
    view.changed()
    guard let image = picture.cgImage else { return }
    append(image, at: now)
  }

  private func append(_ image: CGImage, at time: Double) {
    guard let adaptor, let pool = adaptor.pixelBufferPool else { return }
    var buffer: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess, let buffer else { return }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: Int(size.width), height: Int(size.height),
                                  bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    else { return }
    // Fitted, centred, on black when the window's shape has changed since the first frame.
    context.setFillColor(.black)
    context.fill(CGRect(origin: .zero, size: size))
    let fit = min(size.width / CGFloat(image.width), size.height / CGFloat(image.height))
    let drawn = CGSize(width: CGFloat(image.width) * fit, height: CGFloat(image.height) * fit)
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: (size.width - drawn.width) / 2, y: (size.height - drawn.height) / 2,
                                   width: drawn.width, height: drawn.height))
    let stamp = CMTime(seconds: time, preferredTimescale: 600)
    if adaptor.append(buffer, withPresentationTime: stamp) {
      frames += 1
      seconds = time
    }
  }

  private func even(_ value: Double) -> Int { max(2, Int(value) / 2 * 2) }
}
