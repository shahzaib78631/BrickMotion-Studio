import AppKit
import BMApp
import SwiftUI
import UniformTypeIdentifiers

@MainActor enum StillExport {
  static func preview(_ context: CommandContext) {
    guard let document = context.document, let parent = context.window else { return }
    let project = Data(String(document.session.projectBytes()).utf8)
    let angles = viewAngles(context)
    let library = String(bmapp.Session.ldrawDirectory())
    let name = (document.displayName as NSString).deletingPathExtension
    let sheet = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 672, height: 414),
                         styleMask: [.titled], backing: .buffered, defer: false)
    sheet.title = "Path-Traced Preview"
    let worker = StillProcess()
    let view = StillPreview(name: name, render: {
      await Task.detached(priority: .userInitiated) {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("BrickMotion-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: file) }
        let result = worker.render(project, angles: angles, library: library, to: file, size: "1280x720", samples: 24)
        return (result, try? Data(contentsOf: file))
      }.value
    }, close: { [weak sheet, weak parent] in
      worker.cancel()
      if let sheet, let parent { parent.endSheet(sheet) }
    }, save: { [weak sheet, weak parent] png in
      guard let sheet, let parent else { return }
      parent.endSheet(sheet)
      let panel = NSSavePanel()
      panel.allowedContentTypes = [.png]
      panel.nameFieldStringValue = name + ".png"
      panel.beginSheetModal(for: parent) { response in
        guard response == .OK, let url = panel.url else { return }
        do { try png.write(to: url, options: .atomic) } catch {
          parent.presentError(error, modalFor: parent, delegate: nil, didPresent: nil, contextInfo: nil)
        }
      }
    })
    sheet.contentViewController = NSHostingController(rootView: view)
    parent.beginSheet(sheet) { _ in worker.cancel() }
  }

  private static func viewAngles(_ context: CommandContext) -> [String] {
    guard let camera = context.viewport?.viewport.camera() else { return [] }
    return ["--azimuth", String(camera.yaw * 180 / .pi), "--elevation", String(camera.pitch * 180 / .pi)]
  }

  static func show(_ context: CommandContext) {
    guard let document = context.document, let window = context.window else { return }
    let panel = NSSavePanel()
    panel.allowedContentTypes = [.png]
    panel.nameFieldStringValue = (document.displayName as NSString).deletingPathExtension + ".png"
    panel.beginSheetModal(for: window) { result in
      guard result == .OK, let url = panel.url else { return }
      let project = Data(String(document.session.projectBytes()).utf8)
      let directory = String(bmapp.Session.ldrawDirectory())
      start(project, angles: viewAngles(context), library: directory, destination: url, window: window)
    }
  }

  private static func start(_ project: Data, angles: [String], library: String, destination: URL, window: NSWindow) {
    let worker = StillProcess()
    let activity = NSAlert()
    activity.messageText = "Rendering Still"
    activity.informativeText = destination.lastPathComponent
    activity.addButton(withTitle: "Cancel")
    let progress = NSProgressIndicator(frame: NSRect(x: 0, y: 0, width: 255, height: 15))
    progress.style = .bar
    progress.isIndeterminate = true
    progress.startAnimation(nil)
    activity.accessoryView = progress
    activity.beginSheetModal(for: window) { response in
      if response == .alertFirstButtonReturn { worker.cancel() }
    }
    Task { @MainActor in
      let result = await Task.detached(priority: .userInitiated) {
        worker.render(project, angles: angles, library: library, to: destination)
      }.value
      if activity.window.sheetParent === window { window.endSheet(activity.window, returnCode: .cancel) }
      if case .failed(let reason) = result {
        let error = NSError(domain: "BrickMotion.Export", code: 1, userInfo: [
          NSLocalizedDescriptionKey: "The still could not be rendered.",
          NSLocalizedRecoverySuggestionErrorKey: reason
        ])
        window.presentError(error, modalFor: window, delegate: nil, didPresent: nil, contextInfo: nil)
      }
    }
  }
}

private struct StillPreview: View {
  let name: String
  let render: () async -> (StillProcess.Result, Data?)
  let close: () -> Void
  let save: (Data) -> Void
  @State private var png: Data?
  @State private var image: NSImage?
  @State private var error: String?

  var body: some View {
    VStack(spacing: 12) {
      ZStack {
        RoundedRectangle(cornerRadius: 10).fill(.quaternary.opacity(0.25))
        if let image {
          Image(nsImage: image).resizable().scaledToFit().accessibilityLabel("Path-traced preview of \(name)")
        } else if let error {
          ContentUnavailableView("Preview Couldn’t Render", systemImage: "photo.badge.exclamationmark", description: Text(error))
        } else {
          ProgressView("Rendering \(name)…").controlSize(.regular)
        }
      }
      .frame(width: 640, height: 360)
      .clipShape(.rect(cornerRadius: 10))
      HStack {
        if image != nil {
          Text("1280 × 720 · 24 samples").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
        }
        Spacer()
        Button("Close", action: close).keyboardShortcut(.cancelAction)
        Button("Save Preview…") { if let png { save(png) } }
          .keyboardShortcut(.defaultAction)
          .disabled(image == nil)
      }
    }
    .padding(16)
    .task {
      let (result, bytes) = await render()
      guard !Task.isCancelled else { return }
      switch result {
      case .rendered:
        png = bytes
        image = bytes.flatMap { NSImage(data: $0) }
        if image == nil { error = "The output image could not be read." }
      case .failed(let reason): error = reason
      case .cancelled: break
      }
    }
  }
}

private final class StillProcess: @unchecked Sendable {
  enum Result: Sendable { case rendered, cancelled, failed(String) }
  private let lock = NSLock()
  private var process: Process?
  private var stopped = false

  func cancel() {
    lock.withLock {
      stopped = true
      if let process, process.isRunning { process.terminate() }
    }
  }

  func render(_ project: Data, angles: [String], library: String, to destination: URL,
              size: String = "1920x1080", samples: Int = 32) -> Result {
    let fm = FileManager.default
    let executable = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/bmexport")
    guard fm.isExecutableFile(atPath: executable.path) else { return .failed("The bmexport helper is missing from the app bundle.") }
    let work = fm.temporaryDirectory.appendingPathComponent("BrickMotion-\(UUID().uuidString)", isDirectory: true)
    do {
      try fm.createDirectory(at: work, withIntermediateDirectories: false)
      defer { try? fm.removeItem(at: work) }
      let input = work.appendingPathComponent("Model.brickmotion")
      let image = destination.deletingLastPathComponent().appendingPathComponent(".brickmotion-\(UUID().uuidString).png")
      defer { try? fm.removeItem(at: image) }
      try project.write(to: input, options: .atomic)
      let task = Process()
      let pipe = Pipe()
      task.executableURL = executable
      task.arguments = ["still", input.path, "--out", image.path, "--size", size, "--samples", String(samples), "--no-denoise"] + angles
      task.environment = ProcessInfo.processInfo.environment.merging(["BM_LDRAW_DIR": library], uniquingKeysWith: { _, new in new })
      task.standardError = pipe
      task.standardOutput = FileHandle.nullDevice
      try lock.withLock {
        if stopped { throw CancellationError() }
        try task.run()
        process = task
      }
      let notes = pipe.fileHandleForReading.readDataToEndOfFile()
      task.waitUntilExit()
      return try lock.withLock {
        process = nil
        if stopped { return .cancelled }
        if task.terminationStatus != 0 {
          let reason = String(decoding: notes, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
          return .failed(reason.isEmpty ? "bmexport exited with status \(task.terminationStatus)." : reason)
        }
        if fm.fileExists(atPath: destination.path) { _ = try fm.replaceItemAt(destination, withItemAt: image) }
        else { try fm.moveItem(at: image, to: destination) }
        return .rendered
      }
    } catch is CancellationError {
      return .cancelled
    } catch {
      return .failed(error.localizedDescription)
    }
  }
}
