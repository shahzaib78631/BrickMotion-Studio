import AppKit
import BMApp
import SwiftUI

struct StagingSheet: View {
  private enum Layout: String, CaseIterable, Identifiable {
    case packed, spaced, grid, rows, scattered, showcase, gallery, fan
    case cameraFrame = "camera-frame"

    var id: Self { self }
    var title: String { self == .cameraFrame ? "Camera Frame" : rawValue.capitalized }

    var tile: [(Double, Double, Double, Double)] {
      switch self {
      case .packed: [(0,0,10,4), (11,0,5,4), (17,0,8,4), (0,5,6,4), (7,5,8,4), (16,5,6,4), (0,10,14,4), (15,10,7,4)]
      case .spaced: [(1,0,7,3), (14,0,6,3), (3,6,5,3), (12,6,9,3), (1,12,8,3), (16,12,5,3)]
      case .grid: [(1,0,5,3), (9,0,5,3), (17,0,5,3), (1,5,5,3), (9,5,5,3), (17,5,5,3), (1,10,5,3), (9,10,5,3), (17,10,5,3)]
      case .rows: [(1,2,4,3), (7,2,4,3), (13,2,4,3), (19,2,4,3), (1,10,4,3), (7,10,4,3), (13,10,4,3), (19,10,4,3)]
      case .scattered: [(2,1,7,3), (12,0,4,3), (19,3,5,3), (1,7,5,3), (9,8,8,3), (17,12,7,3), (4,13,6,2)]
      case .showcase: [(5,0,6,3), (13,0,7,3), (0,6,5,3), (7,6,5,3), (14,6,4,3), (20,6,5,3), (6,12,6,3), (14,12,5,3)]
      case .gallery: [(6,0,5,3), (14,0,5,3), (3,6,6,3), (11,6,6,3), (19,6,4,3), (6,12,6,3), (14,12,5,3)]
      case .fan: [(9,1,7,3), (3,4,5,3), (17,4,5,3), (0,9,5,3), (7,10,5,3), (14,10,5,3), (21,9,4,3)]
      case .cameraFrame: [(6,2,5,3), (14,2,5,3), (3,7,5,3), (18,7,5,3), (7,11,5,3), (14,11,5,3)]
      }
    }
  }

  private enum Group: String, CaseIterable, Identifiable {
    case step, colour, part, size, all
    var id: Self { self }
    var title: String { self == .all ? "All at Once" : "By " + rawValue.capitalized }
  }

  private enum Side: String, CaseIterable, Identifiable {
    case frontBack = "front-back"
    case front, behind, sides, around
    var id: Self { self }
    var title: String {
      switch self {
      case .frontBack: "Front and Back"
      case .front: "Front"
      case .behind: "Behind"
      case .sides: "Left and Right"
      case .around: "All Around"
      }
    }
  }

  private enum Match: String, CaseIterable, Identifiable {
    case fill, nearest
    var id: Self { self }
    var title: String { self == .fill ? "Fill in Order" : "Nearest to Final Position" }
  }

  @State private var layout: Layout
  @State private var group: Group
  @State private var sides: Side
  @State private var match: Match
  @State private var aspect: Double
  /// The whole staging area turned about the model, degrees.
  @State private var turn: Double
  /// Waiting parts turned or dragged one by one, and whether to put them back.
  private let turned: Int
  @State private var straighten = false
  private let frameSizes: [(String, Double)] = [("Landscape · 16:9", 16.0 / 9), ("Square · 1:1", 1),
    ("Portrait · 4:5", 4.0 / 5), ("Vertical · 9:16", 9.0 / 16)]
  private let apply: (Choice) -> Void
  private let close: () -> Void

  struct Choice {
    var settings: bmapp.StagingSettings
    var turn: Double
    var straighten: Bool
  }

  init(_ settings: bmapp.StagingSettings, turn: Double, turned: Int,
       apply: @escaping (Choice) -> Void, close: @escaping () -> Void) {
    _turn = State(initialValue: turn)
    self.turned = turned
    _layout = State(initialValue: Layout(rawValue: String(settings.layout)) ?? .packed)
    _group = State(initialValue: Group(rawValue: String(settings.group)) ?? .step)
    _sides = State(initialValue: Side(rawValue: String(settings.sides)) ?? .frontBack)
    _match = State(initialValue: Match(rawValue: String(settings.match)) ?? .fill)
    _aspect = State(initialValue: settings.aspect)
    self.apply = apply
    self.close = close
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      VStack(alignment: .leading, spacing: 4) {
        Text("Build Staging").font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
        Text("Arrange the parts waiting to be built.").font(.subheadline).foregroundStyle(.secondary)
      }
      LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 3), spacing: 8) {
        ForEach(Layout.allCases) { option in
          Button {
            layout = option
          } label: {
            tile(option)
          }
          .buttonStyle(.plain)
          .accessibilityLabel(option.title)
          .accessibilityAddTraits(layout == option ? [.isSelected] : [])
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Staging Layout")
      Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 12) {
        GridRow {
          Text("Group").accessibilityHidden(true)
          Picker("Group", selection: $group) { ForEach(Group.allCases) { Text($0.title).tag($0) } }.labelsHidden()
        }
        GridRow {
          Text("Placement").accessibilityHidden(true)
          Picker("Placement", selection: $sides) { ForEach(Side.allCases) { Text($0.title).tag($0) } }.labelsHidden()
        }
        GridRow {
          Text("Order").accessibilityHidden(true)
          Picker("Order", selection: $match) { ForEach(Match.allCases) { Text($0.title).tag($0) } }.labelsHidden()
        }
        GridRow(alignment: .firstTextBaseline) {
          Text("Turn").accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
              Slider(value: Binding(get: { turn }, set: { turn = ($0 / 5).rounded() * 5 }), in: -180...180) {
                Text("Turn")
              } minimumValueLabel: {
                Image(systemName: "rotate.left").accessibilityHidden(true)
              } maximumValueLabel: {
                Image(systemName: "rotate.right").accessibilityHidden(true)
              }
              .labelsHidden()
              .accessibilityLabel("Turn the waiting parts about the model")
              .accessibilityValue("\(Int(turn)) degrees")
              TextField("Turn", value: $turn, format: .number.precision(.fractionLength(0...1)))
                .labelsHidden().multilineTextAlignment(.trailing).monospacedDigit().frame(width: 46)
                .onSubmit { turn = min(180, max(-180, turn)) }
              Text("°").foregroundStyle(.secondary)
              Button {
                turn = 0
              } label: {
                Image(systemName: "arrow.counterclockwise")
              }
              .buttonStyle(.borderless)
              .disabled(turn == 0)
              .help("Put the staging area back where it was planned")
              .accessibilityLabel("Reset turn")
            }
            Text("The waiting parts swing round the model; each still lands on its seat.")
              .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
          }
        }
        if turned > 0 {
          GridRow(alignment: .firstTextBaseline) {
            Text("Waiting Parts").accessibilityHidden(true)
            Toggle(isOn: $straighten) {
              Text(turned == 1 ? "Put back the part turned or moved on the floor" : "Put back the \(turned) parts turned or moved on the floor")
            }
            .toggleStyle(.checkbox)
            .help("Parts turned with Turn Waiting Part or dragged in the preview wait where they are laid out again")
          }
        }
        if layout == .cameraFrame {
          GridRow {
            Text("Frame Shape").accessibilityHidden(true)
            Picker("Frame Shape", selection: $aspect) {
              ForEach(frameSizes, id: \.0) { frame in Text(frame.0).tag(frame.1) }
              if !frameSizes.contains(where: { $0.1 == aspect }) { Text("Project Frame Shape").tag(aspect) }
            }
            .labelsHidden()
          }
        }
      }
      Divider()
      HStack {
        Button("Reset", action: reset)
        Spacer()
        Button("Cancel", action: close).keyboardShortcut(.cancelAction)
        Button("Apply & Preview", action: commit).keyboardShortcut(.defaultAction)
      }
    }
    .padding(23)
    .frame(width: 460)
  }

  private func tile(_ option: Layout) -> some View {
    let selected = layout == option
    return VStack(spacing: 5) {
      Canvas { context, size in
        let dx = size.width / 25, dy = size.height / 15
        for (index, item) in option.tile.enumerated() {
          let rect = CGRect(x: item.0 * dx, y: item.1 * dy, width: item.2 * dx, height: item.3 * dy)
          let tint = selected ? Color.accentColor : Color.secondary
          context.fill(Path(roundedRect: rect, cornerRadius: 1.6), with: .color(tint.opacity(index.isMultiple(of: 3) ? 0.88 : 0.46)))
        }
      }
      .frame(width: 42, height: 23)
      .accessibilityHidden(true)
      Text(option.title).font(.callout.weight(.medium))
    }
    .frame(maxWidth: .infinity)
    .frame(height: 63)
    .background(selected ? Color.accentColor.opacity(0.10) : Color.primary.opacity(0.04), in: .rect(cornerRadius: 8))
    .overlay {
      RoundedRectangle(cornerRadius: 8)
        .strokeBorder(selected ? Color.accentColor : Color.primary.opacity(0.12), lineWidth: selected ? 1.5 : 1)
    }
    .contentShape(.rect(cornerRadius: 8))
  }

  private func reset() {
    layout = .packed
    group = .step
    sides = .frontBack
    match = .fill
    aspect = 1
    turn = 0
  }

  private func commit() {
    var settings = bmapp.StagingSettings()
    settings.layout = std.string(layout.rawValue)
    settings.group = std.string(group.rawValue)
    settings.sides = std.string(sides.rawValue)
    settings.match = std.string(match.rawValue)
    settings.aspect = aspect
    apply(Choice(settings: settings, turn: min(180, max(-180, turn)), straighten: straighten))
  }

  static func show(_ context: CommandContext) {
    guard let model = context.model, let window = context.window, window.attachedSheet == nil else { return }
    let sheet = NSWindow()
    let session = model.document.session
    let view = StagingSheet(session.stagingSettings(), turn: session.stagingTurn(), turned: Int(session.movedWaitingParts()),
                            apply: { [weak model, weak sheet, weak window] choice in
      guard let model, let window, let sheet else { return }
      window.endSheet(sheet)
      // one undo step for everything the sheet changed
      guard context.perform({ $0.applyStaging(choice.settings, choice.turn, choice.straighten) }) else { return }
      (window.windowController as? WindowController)?.setAnimateMode(true, plan: false)
      model.animation.previewStaging()
    }, close: { [weak window, weak sheet] in if let sheet { window?.endSheet(sheet) } })
    sheet.contentViewController = NSHostingController(rootView: view)
    window.beginSheet(sheet)
  }
}
