import AppKit
import BMApp
import SwiftUI

private func stepTitle(_ row: bmapp.StepRow) -> String {
  let title = String(row.title)
  return title.isEmpty ? "Step \(row.index + 1)" : "Step \(row.index + 1) · \(title)"
}

private extension bmapp.MotionFields {
  var hasOverride: Bool { time >= 0 || landing >= 0 || hover >= 0 || ease >= 0 }
}

@MainActor
enum TimelinePartMenu {
  static func make(flight: AnimationWorkspace.Flight, model: DocumentModel, selection: [UInt32] = [],
                   reveal: @escaping () -> Void, editMotion: @escaping () -> Void,
                   editFlight: (() -> Void)? = nil) -> NSMenu {
    let menu = NSMenu()
    menu.autoenablesItems = false
    let session = model.document.session
    let step = flight.step
    let id = flight.id
    let ids = selection.isEmpty ? [id] : selection
    let single = ids.count == 1
    let name = displayName(String(session.partAt(id).description))
    let code = displayName(flight.part)
    let local = ids.allSatisfy { session.isLocalPiece($0) }
    let items = local ? Array(session.stepItems(step)) : []
    let index = items.firstIndex { $0.pieces.contains(id) }

    let title = single ? (name == code || name.isEmpty ? code : "\(name) · \(code)") : "\(ids.count) Parts"
    menu.addItem(.sectionHeader(title: title))
    let ownStep = Set(items.flatMap { Array($0.pieces) })
    let sameStep = ids.allSatisfy(ownStep.contains)
    if single, let index {
      menu.addItem(.sectionHeader(title: "Step \(step + 1) · Arrival \(index + 1) of \(items.count)"))
    } else if sameStep {
      menu.addItem(.sectionHeader(title: "Step \(step + 1)"))
    }
    menu.addItem(TimelineMenuAction("Frame in View", symbol: "viewfinder") {
      reveal()
      if !single { model.select(pieces: ids) }
      model.viewport?.frameSelection(nil)
    })
    if let editFlight, single {
      menu.addItem(TimelineMenuAction("Edit Flight as Keyframes", symbol: "diamond", action: editFlight))
    }
    if !local && single {
      menu.addItem(TimelineMenuAction("Open Containing Submodel", symbol: "arrow.down.right.square") {
        model.select(pieces: [id])
        let context = CommandContext(document: model.document, viewport: model.viewport, clickedPiece: id)
        Registry.command("object.openSubmodel")?.run(context)
      })
    }
    if let index {
      menu.addItem(.separator())
      menu.addItem(.sectionHeader(title: "Order"))
      let pinnedIDs = single ? [] : Set(session.arrivalPins())
      let pinned = single ? flight.pinned : ids.allSatisfy(pinnedIDs.contains)
      let pinTitle = pinned ? "Release Arrival Pins" : single ? "Pin This Arrival" : "Pin Selected Arrivals"
      menu.addItem(TimelineMenuAction(pinTitle, symbol: pinned ? "pin.slash" : "pin") {
        model.context.perform { $0.setArrivalPinned(ViewportView.list(ids), !pinned) }
      })
      let existing = NSMenu()
      existing.autoenablesItems = false
      for row in model.steps {
        let destination = Int(row.index)
        existing.addItem(TimelineMenuAction(stepTitle(row), enabled: destination != step || !sameStep) {
          model.context.perform { $0.moveToStep(ViewportView.list(ids), destination) }
        })
      }
      let move = TimelineMenuAction("Move to Step", symbol: "list.number", enabled: model.steps.count > 1) {}
      move.submenu = existing
      menu.addItem(move)

      let new = NSMenu()
      new.autoenablesItems = false
      func addDestination(_ title: String, _ destination: Int) {
        new.addItem(TimelineMenuAction(title) {
          model.context.perform { $0.moveToNewStep(ViewportView.list(ids), destination) }
        })
      }
      addDestination("Before Step \(step + 1)", step)
      addDestination("After Step \(step + 1)", step + 1)
      new.addItem(.separator())
      addDestination("At the Start", 0)
      addDestination("At the End", model.steps.count)
      let insert = TimelineMenuAction("Move to a New Step", symbol: "plus") {}
      insert.submenu = new
      menu.addItem(insert)

      if single {
        menu.addItem(TimelineMenuAction("Split Step at This Part", symbol: "arrow.left.and.right", enabled: index > 0) {
          model.context.perform { $0.splitStepAt(step, index) }
        })
        func addOrder(_ title: String, _ symbol: String, _ destination: Int) {
          menu.addItem(TimelineMenuAction(title, symbol: symbol,
                                          enabled: items.indices.contains(destination) && index != destination) {
            model.context.perform { $0.reorderArrival(step, index, destination) }
          })
        }
        addOrder("Arrive Earlier", "chevron.up", index - 1)
        addOrder("Arrive Later", "chevron.down", index + 1)
        addOrder("Arrive First", "backward.end", 0)
        addOrder("Arrive Last", "forward.end", items.count - 1)
      } else {
        menu.addItem(TimelineMenuAction("Split Selected Parts into New Step",
                                        symbol: "arrow.left.and.right", enabled: !sameStep || ids.count < ownStep.count) {
          if sameStep {
            model.context.perform { $0.splitStep(step, ViewportView.list(ids)) }
          } else {
            model.context.perform { $0.moveToNewStep(ViewportView.list(ids), step + 1) }
          }
        })
      }
    }
    menu.addItem(.separator())
    menu.addItem(.sectionHeader(title: "Motion"))
    menu.addItem(TimelineMenuAction(single ? "Motion for This Part…" : "Motion for \(ids.count) Parts…", symbol: "slider.horizontal.3", action: editMotion))
    let hasMotion = session.motionFields(.Parts, step, ViewportView.list(ids)).hasOverride
    menu.addItem(TimelineMenuAction("Use Step or Project Motion", symbol: "arrow.uturn.backward", enabled: hasMotion) {
      model.context.perform { $0.setMotionFields(.Parts, step, ViewportView.list(ids), .init()) }
    })
    menu.addItem(.separator())
    menu.addItem(TimelineMenuAction(single ? "Delete Part" : "Delete \(ids.count) Parts", symbol: "trash") {
      model.context.perform { $0.remove(ViewportView.list(ids)) }
    })
    return menu
  }
}

private final class TimelineMenuAction: NSMenuItem {
  private let callback: () -> Void

  init(_ title: String, symbol: String? = nil, enabled: Bool = true, action: @escaping () -> Void) {
    callback = action
    super.init(title: title, action: #selector(runAction), keyEquivalent: "")
    target = self
    isEnabled = enabled
    if let symbol { image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) }
  }

  @available(*, unavailable)
  required init(coder: NSCoder) { fatalError("Timeline menu items are created on demand") }

  @objc private func runAction() { callback() }
}


struct TimelineStepMenu: View {
  let step: Int
  let model: DocumentModel
  let editStep: () -> Void
  let editMotion: () -> Void

  private var session: bmapp.Session { model.document.session }
  private var workspace: AnimationWorkspace { model.animation }

  var body: some View {
    if model.steps.indices.contains(step) {
      let row = model.steps[step]
      let items = model.items(of: step)
      let selection = Set(model.snapshot.selection)
      let split = items.filter { !$0.pieces.isEmpty && $0.pieces.allSatisfy { selection.contains($0) } }
      let splitPieces = split.flatMap { Array($0.pieces) }
      let playhead = workspace.currentStep
      Section(stepTitle(row)) {
        Text("\(row.pieces) \(row.pieces == 1 ? "part" : "parts")")
        Button("Select Parts", systemImage: "cursorarrow") { model.select(step: step) }.disabled(row.pieces == 0)
        Button("Show This Step", systemImage: "square.3.layers.3d") { workspace.arrange(step: step, mode: .Assembled) }
        Button("Play Step", systemImage: "play") { workspace.play(step: step) }
        Button("Play to End", systemImage: "play.rectangle") { workspace.play(step: step, throughEnd: true) }
        Button("Stop at End of Step") { workspace.select(step: step) }
        Button("Edit Step…", systemImage: "pencil", action: editStep)
      }
      Section("Split and Join") {
        Button("Split in Half") { model.context.perform { $0.splitStepAt(step, (items.count + 1) / 2) } }
          .disabled(items.count < 2)
        Button("Split Off Selected Parts") { model.context.perform { $0.splitStep(step, ViewportView.list(splitPieces)) } }
          .disabled(split.isEmpty || split.count == items.count)
        Button("Gather Selection into New Step After This") {
          model.context.perform { $0.moveToNewStep(model.snapshot.selection, step + 1) }
        }
        .disabled(selection.isEmpty)
        Button("Join Previous Step") { model.context.perform { $0.mergeSteps(step - 1) } }.disabled(step == 0)
        Button("Join Next Step") { model.context.perform { $0.mergeSteps(step) } }.disabled(step + 1 >= model.steps.count)
      }
      Section("Order") {
        Button("Move Step Earlier") { move(to: step - 1) }.disabled(step == 0)
        Button("Move Step Later") { move(to: step + 1) }.disabled(step + 1 >= model.steps.count)
        Menu("Move This Step Before…", systemImage: "list.number") {
          ForEach(model.steps, id: \.index) { row in
            Button(stepTitle(row)) { move(to: destination(before: Int(row.index))) }
              .disabled(destination(before: Int(row.index)) == step)
          }
        }
        .disabled(model.steps.count < 3)
        Button(playhead.map { "Move Before Step \($0 + 1) at Playhead" } ?? "Move Before Playhead Step") {
          if let playhead { move(to: destination(before: playhead)) }
        }
        .disabled(playhead == nil || playhead.map(destination(before:)) == step)
        Toggle("Keep Arrival Order", isOn: Binding(get: { session.stepFields(step).pinOrder }, set: { pinned in
          var fields = session.stepFields(step)
          fields.pinOrder = pinned
          model.context.perform { $0.setStepFields(step, fields, false) }
        }))
        Divider()
        Button("Insert Empty Step Before", systemImage: "plus") { model.context.perform { $0.insertStep(step) } }
        Button("Insert Empty Step After", systemImage: "plus") { model.context.perform { $0.insertStep(step + 1) } }
      }
      Section("Motion") {
        Button("Motion for This Step…", systemImage: "slider.horizontal.3", action: editMotion)
        Button("Use Project Motion", systemImage: "arrow.uturn.backward") {
          model.context.perform { $0.setMotionFields(.Step, step, .init(), .init()) }
        }
        .disabled(!session.motionFields(.Step, step, .init()).hasOverride)
      }
      Divider()
      Button(role: .destructive) { model.context.perform { $0.deleteStep(step) } } label: {
        Label(row.pieces == 0 ? "Delete Empty Step" : "Delete Step and Keep Its Parts", systemImage: "trash")
      }
      .disabled(model.steps.count == 1 && row.pieces > 0)
    }
  }

  private func destination(before other: Int) -> Int { other > step ? other - 1 : other }

  private func move(to index: Int) {
    guard model.steps.indices.contains(index), index != step else { return }
    let version = session.version()
    if model.context.perform({ $0.moveStep(step, index) }), session.version() > version {
      workspace.focusedStep = index
    }
  }
}
