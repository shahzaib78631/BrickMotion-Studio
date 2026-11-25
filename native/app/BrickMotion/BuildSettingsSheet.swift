// Step → Build Settings: how the native planner orders the build and flies each part in. The
// project keeps them (one undo step), so the preview and every export plan the same build.
import AppKit
import BMApp
import SwiftUI

struct BuildSettingsSheet: View {
  @State private var settings: bmapp.BuildSettings
  @State private var pathShown = false
  private let apply: (bmapp.BuildSettings) -> Void
  private let close: () -> Void

  private var standard: Bool { settings.standardPlanner }

  init(_ settings: bmapp.BuildSettings,
       apply: @escaping (bmapp.BuildSettings) -> Void, close: @escaping () -> Void) {
    _settings = State(initialValue: settings)
    self.apply = apply
    self.close = close
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      VStack(alignment: .leading, spacing: 3) {
        Text("Build Settings").font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
        Text("Saved with the project: the preview and every export plan the same build.")
          .font(.subheadline).foregroundStyle(.secondary)
      }
      Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 10) {
        GridRow {
          label("Planner")
          VStack(alignment: .leading, spacing: 4) {
            Picker("Planner", selection: $settings.standardPlanner) {
              Text("Native").tag(false)
              Text("Standard").tag(true)
            }
            .pickerStyle(.segmented).labelsHidden().fixedSize()
            caption(standard ? "Authored step order, as the web's planner. Flights are not collision-checked."
                             : "Every flight is planned to clear the parts already built.")
          }
        }
        GridRow {
          label("Order")
          VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
              OrderCard(title: "Bottom Up", detail: "Built forward from the base",
                        bottomUp: true, selected: settings.order == .BottomUp) { settings.order = .BottomUp }
              OrderCard(title: "Take Apart", detail: "Planned by taking it apart",
                        bottomUp: false, selected: settings.order == .TakeApart) { settings.order = .TakeApart }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Build Order")
            Toggle("Split grown units the planner still flags", isOn: $settings.cleanGrownUnits)
              .toggleStyle(.checkbox)
              .help("A multi-part unit whose own plan leaves a part flagged flies piece by piece instead")
          }
          .disabled(standard)
        }
        GridRow {
          label("Flights")
          VStack(alignment: .leading, spacing: 4) {
            Picker("Flight Shape", selection: $settings.flight) {
              Text("Automatic").tag(bmapp.FlightShape.Automatic)
              Text("Web").tag(bmapp.FlightShape.Web)
              Text("Arc").tag(bmapp.FlightShape.Arc)
            }
            .pickerStyle(.segmented).labelsHidden().fixedSize()
            caption(standard ? "The standard planner has a single flight shape." : flightCaption)
          }
          .disabled(standard)
        }
        Divider().gridCellUnsizedAxes(.horizontal)
        if settings.videoSeconds > 0 {
          GridRow {
            Color.clear.frame(width: 1, height: 1)
            Label("The \(seconds(settings.videoSeconds)) video length sets each flight and step hold.",
                  systemImage: "info.circle").font(.caption).foregroundStyle(.secondary)
          }
        }
        slider("Each flight", value: flightSeconds, in: 0.35...0.9, step: 0.05, text: seconds(flightSeconds.wrappedValue),
               note: "Motion’s flight time scales this for a step or part.")
          .disabled(settings.videoSeconds > 0)
        slider("Gap between parts", value: $settings.gap, in: 0...2, step: 0.05, text: seconds(settings.gap))
        slider("Hold at each step", value: $settings.stepPause, in: 0...2, step: 0.05, text: seconds(settings.stepPause),
               note: "Never more than a fifth of the flying time in all.")
          .disabled(settings.videoSeconds > 0)
      }
      DisclosureGroup("Flight Path", isExpanded: $pathShown) {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 10) {
          slider("Clearance", value: $settings.clearance, in: 4...200, step: 4, text: studs(settings.clearance),
                 note: "How high a lifted flight keeps above the build.")
          slider("Corner rounding", value: $settings.corner, in: 0...80, step: 2, text: studs(settings.corner),
                 note: settings.flight == .Arc ? "How wide the arc turns from up to across." : "Used by Arc flights.")
            .disabled(settings.flight != .Arc)
        }
        .padding(.top, 6)
        .disabled(standard)
      }
      Divider()
      HStack {
        Button("Restore Defaults") {
          let videoSeconds = settings.videoSeconds
          settings = bmapp.BuildSettings()
          settings.videoSeconds = videoSeconds
        }
        Spacer()
        Button("Cancel", action: close).keyboardShortcut(.cancelAction)
        Button("Apply & Preview") { apply(settings) }.keyboardShortcut(.defaultAction)
      }
    }
    .padding(20)
    .frame(width: 540)
  }

  private var flightCaption: String {
    switch settings.flight {
    case .Web: "The web app’s flight, so native videos match its timing and path."
    case .Arc: "One smooth arc from the floor into the seat."
    default: "The planner picks the flight that clears the build."
    }
  }

  private func label(_ title: String) -> some View {
    Text(title).foregroundStyle(.secondary).lineLimit(1).fixedSize().gridColumnAlignment(.trailing)
      .accessibilityHidden(true)
  }

  private func caption(_ text: String) -> some View {
    Text(text).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
  }

  /// A flight's length, as the planner times it: 0.85 / parts a second, held to 0.35–0.9 s.
  private var flightSeconds: Binding<Double> {
    Binding(get: { min(0.9, max(0.35, 0.85 / max(0.01, settings.piecesPerSecond))) },
            set: { settings.piecesPerSecond = 0.85 / $0 })
  }

  /// A slider without tick marks; the value is rounded to `step`.
  private func slider(_ title: String, value: Binding<Double>, in range: ClosedRange<Double>, step: Double,
                      text: String, note: String? = nil) -> some View {
    let rounded = Binding(get: { value.wrappedValue },
                          set: { value.wrappedValue = min(range.upperBound, max(range.lowerBound, ($0 / step).rounded() * step)) })
    return GridRow {
      label(title)
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 10) {
          Slider(value: rounded, in: range).frame(width: 220).accessibilityLabel(title).accessibilityValue(text)
          Text(text).monospacedDigit().foregroundStyle(.secondary).frame(width: 70, alignment: .trailing)
        }
        if let note { caption(note) }
      }
    }
  }

  private func seconds(_ value: Double) -> String {
    "\(value.formatted(.number.precision(.fractionLength(0...2)))) s"
  }

  /// LDU as people read them: 20 LDU a stud.
  private func studs(_ ldu: Double) -> String {
    "\((ldu / 20).formatted(.number.precision(.fractionLength(0...1)))) st"
  }

  static func show(_ context: CommandContext) {
    guard let model = context.model, let window = context.window, window.attachedSheet == nil else { return }
    let sheet = NSWindow()
    let view = BuildSettingsSheet(model.document.session.buildSettings(),
                                  apply: { [weak model, weak sheet, weak window] settings in
      guard let model, let window, let sheet else { return }
      window.endSheet(sheet)
      guard context.perform({ $0.setBuildSettings(settings) }) else { return }
      (window.windowController as? WindowController)?.setAnimateMode(true, plan: false)
      // The project's planner now decides; drop a Standard Preview the timeline fell back to.
      if model.animation.standardPreview { model.animation.regenerate() }
      model.animation.previewStaging()
    }, close: { [weak window, weak sheet] in if let sheet { window?.endSheet(sheet) } })
    sheet.contentViewController = NSHostingController(rootView: view)
    window.beginSheet(sheet)
  }
}

/// A build order, drawn: bricks stacking from the base, or lifting off the finished model.
private struct OrderCard: View {
  let title, detail: String
  let bottomUp, selected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        Canvas { context, size in
          let tint = selected ? Color.accentColor : Color.secondary
          let w = size.width, h = size.height / 4
          for row in 0..<3 {
            let y = size.height - CGFloat(row + 1) * (h + 2)
            let lifted = !bottomUp && row == 2
            let rect = CGRect(x: w * 0.12 + CGFloat(row) * 3, y: lifted ? y - 5 : y, width: w * 0.76 - CGFloat(row) * 6, height: h)
            let fresh = row == 2  // the part arriving, or leaving
            context.fill(Path(roundedRect: rect, cornerRadius: 1.5), with: .color(tint.opacity(fresh ? 0.95 : 0.4)))
          }
          var arrow = Path()
          let x = w * 0.92
          if bottomUp {
            arrow.move(to: CGPoint(x: x, y: size.height * 0.05)); arrow.addLine(to: CGPoint(x: x, y: size.height * 0.42))
            arrow.move(to: CGPoint(x: x - 3, y: size.height * 0.33)); arrow.addLine(to: CGPoint(x: x, y: size.height * 0.42))
            arrow.addLine(to: CGPoint(x: x + 3, y: size.height * 0.33))
          } else {
            arrow.move(to: CGPoint(x: x, y: size.height * 0.42)); arrow.addLine(to: CGPoint(x: x, y: size.height * 0.05))
            arrow.move(to: CGPoint(x: x - 3, y: size.height * 0.14)); arrow.addLine(to: CGPoint(x: x, y: size.height * 0.05))
            arrow.addLine(to: CGPoint(x: x + 3, y: size.height * 0.14))
          }
          context.stroke(arrow, with: .color(tint), style: StrokeStyle(lineWidth: 1.3, lineCap: .round, lineJoin: .round))
        }
        .frame(width: 30, height: 28)
        .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text(title).font(.callout.weight(.semibold))
          Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .frame(width: 180, alignment: .leading)
      .background(selected ? Color.accentColor.opacity(0.10) : Color.primary.opacity(0.04), in: .rect(cornerRadius: 8))
      .overlay {
        RoundedRectangle(cornerRadius: 8)
          .strokeBorder(selected ? Color.accentColor : Color.primary.opacity(0.12), lineWidth: selected ? 1.5 : 1)
      }
      .contentShape(.rect(cornerRadius: 8))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(title)
    .accessibilityHint(detail)
    .accessibilityAddTraits(selected ? [.isSelected] : [])
  }
}
