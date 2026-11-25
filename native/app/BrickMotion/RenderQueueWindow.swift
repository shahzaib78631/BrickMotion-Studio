import AppKit
import SwiftUI

@MainActor final class RenderQueueWindow: NSWindowController {
  static let shared = RenderQueueWindow()

  private init() {
    let content = NSHostingController(rootView: RenderQueueView(queue: .shared))
    let window = NSWindow(contentViewController: content)
    window.title = "Render Queue"
    window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
    window.contentMinSize = NSSize(width: 430, height: 270)
    window.isRestorable = false
    window.isReleasedWhenClosed = false
    window.setContentSize(NSSize(width: 560, height: 380))
    super.init(window: window)
    if !window.setFrameUsingName("BrickMotionRenderQueue") { window.center() }
    window.setFrameAutosaveName("BrickMotionRenderQueue")
  }

  @available(*, unavailable) required init?(coder: NSCoder) { fatalError("not from a nib") }
}

private struct RenderQueueView: View {
  let queue: RenderQueue

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if queue.jobs.isEmpty {
        ContentUnavailableView("No Exports", systemImage: "film.stack",
                               description: Text("Build, Keyframes, and Turntable exports appear here."))
      } else {
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(queue.jobs) { job in
              RenderQueueRow(job: job, cancel: { queue.cancel(job) })
                .padding(.horizontal, 18)
                .padding(.vertical, 13)
              Divider().padding(.leading, 50)
            }
          }
        }
        .defaultScrollAnchor(.top)
      }
      Divider()
      HStack {
        let remaining = queue.jobs.count { !$0.status.finished }
        Text(remaining == 0 ? "No exports in progress" : remaining == 1 ? "1 export in progress" : "\(remaining) exports in progress")
          .font(.caption)
          .foregroundStyle(.secondary)
        Spacer()
        Button("Clear Finished") { queue.clearFinished() }.disabled(!queue.hasFinishedJobs)
      }
      .padding(.horizontal, 18)
      .padding(.vertical, 11)
    }
  }
}

private struct RenderQueueRow: View {
  let job: RenderJob
  let cancel: () -> Void

  var body: some View {
    HStack(alignment: .top, spacing: 11) {
      Image(systemName: icon)
        .font(.title3)
        .foregroundStyle(tint)
        .frame(width: 21, height: 21)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 5) {
        Text(job.destination.lastPathComponent).font(.headline).lineLimit(1).truncationMode(.middle)
          .help(job.destination.path)
        Text(job.summary).font(.caption).foregroundStyle(.secondary)
        if case let .rendering(done, total) = job.status {
          if total > 0 && done < total {
            ProgressView(value: Double(done), total: Double(total)).accessibilityLabel("Frames Rendered")
          } else {
            ProgressView().progressViewStyle(.linear).accessibilityLabel(statusText)
          }
        }
        Text(statusText).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      switch job.status {
      case .queued, .rendering:
        Button("Cancel", action: cancel).accessibilityLabel("Cancel \(job.destination.lastPathComponent)")
      case .complete:
        Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([job.destination]) }
          .accessibilityLabel("Show \(job.destination.lastPathComponent) in Finder")
      default: EmptyView()
      }
    }
  }

  private var icon: String {
    switch job.status {
    case .complete: "checkmark.circle.fill"
    case .interrupted, .failed: "exclamationmark.circle.fill"
    case .cancelled, .cancelling: "xmark.circle"
    case .queued: "clock"
    case .rendering: "film"
    }
  }

  private var tint: Color {
    switch job.status {
    case .complete: .green
    case .interrupted, .failed: .orange
    case .rendering: .accentColor
    default: .secondary
    }
  }

  private var statusText: String {
    switch job.status {
    case .queued: "Waiting to render"
    case .rendering(let done, let total):
      if total == 0 { "Preparing render…" }
      else if done == total { "Finalizing…" }
      else { "Frame \(done.formatted()) of \(total.formatted())" }
    case .cancelling: "Cancelling…"
    case .cancelled: "Cancelled"
    case .complete: "Exported"
    case .interrupted: "Interrupted when BrickMotion closed"
    case .failed(let reason): reason
    }
  }
}
