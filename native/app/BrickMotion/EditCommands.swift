// Editing from the menus and the keyboard. Every edit goes through Document.perform, which
// names its undo; selection and hiding are view state and are not undone.
import AppKit
import BMApp

extension ViewportView: NSMenuItemValidation {
  // MARK: State

  var session: bmapp.Session { document!.session }
  var selection: bmapp.PieceList { session.selection() }
  private var hasSelection: Bool { !session.selection().isEmpty }

  /// Runs an edit of the selection; with nothing selected, beeps and changes nothing.
  private func editSelection(_ edit: (bmapp.PieceList) -> bmapp.Changed) {
    guard let document, hasSelection else {
      NSSound.beep()
      return
    }
    let pieces = selection
    document.perform { edit(pieces) }
    changed()
  }

  /// Selection or hiding changed.
  func viewStateChanged() {
    viewport.showSelection()
    document?.postChange()
    changed()
  }

  func select(_ pieces: [UInt32], _ mode: bmapp.SelectMode) {
    session.select(Self.list(pieces), mode)
    viewStateChanged()
  }

  static func list(_ pieces: [UInt32]) -> bmapp.PieceList {
    var out = bmapp.PieceList()
    for p in pieces { out.push_back(p) }
    return out
  }

  // MARK: Edits

  /// Moves the selection by a world offset, as one undo step per key press.
  func nudge(_ delta: bmapp.Vec3) {
    editSelection { session.move($0, delta, false) }
  }

  @objc func deletePieces(_ sender: Any?) {
    editSelection { session.remove($0) }
  }

  @objc func delete(_ sender: Any?) { deletePieces(sender) }

  @objc func duplicatePieces(_ sender: Any?) {
    editSelection { session.duplicate($0, bmapp.Vec3(x: bmapp.kStud, y: 0, z: 0)) }
    viewStateChanged()
  }

  /// C: copies in the same place, selected, ready to be moved off.
  @objc func clonePieces(_ sender: Any?) {
    editSelection { session.duplicate($0, bmapp.Vec3()) }
    viewStateChanged()
  }

  @objc func copy(_ sender: Any?) {
    guard hasSelection else { return NSSound.beep() }
    Pasteboard.write(String(session.copy(selection)))
  }

  @objc func cut(_ sender: Any?) {
    guard hasSelection else { return NSSound.beep() }
    copy(sender)
    deletePieces(sender)
  }

  @objc func paste(_ sender: Any?) {
    guard let document, let text = Pasteboard.read() else { return NSSound.beep() }
    // Where the pieces were: from another document they land where they were there.
    document.perform { session.paste(std.string(text), bmapp.Vec3()) }
    viewStateChanged()
  }

  /// R turns a quarter clockwise seen from above, Shift-R the other way, about the selection's middle.
  @objc func rotatePieces(_ sender: Any?) { turn(clockwise: true) }
  @objc func rotatePiecesBack(_ sender: Any?) { turn(clockwise: false) }

  private func turn(clockwise: Bool) {
    let pivot = viewport.selectionCenter()
    // -y is up: a right-handed turn about +y is clockwise seen from above.
    editSelection { session.rotate($0, bmapp.Vec3(x: 0, y: 1, z: 0), clockwise ? 90 : -90, pivot, false) }
  }

  @objc func raisePieces(_ sender: Any?) { nudge(bmapp.Vec3(x: 0, y: -bmapp.kPlate, z: 0)) }
  @objc func lowerPieces(_ sender: Any?) { nudge(bmapp.Vec3(x: 0, y: bmapp.kPlate, z: 0)) }

  @objc func makeUnique(_ sender: Any?) {
    guard let document, session.selection().size() == 1 else { return NSSound.beep() }
    let piece = selection[0]
    document.perform { session.makeUnique(piece) }
    changed()
  }

  @objc func replacePart(_ sender: Any?) {
    guard hasSelection, let window else { return NSSound.beep() }
    ReplacePartSheet.present(on: window, session: session) { [weak self] part in
      self?.editSelection { self!.session.replacePart($0, std.string(part)) }
    }
  }

  // MARK: Selection and hiding

  override func selectAll(_ sender: Any?) {
    session.selectAll()
    viewStateChanged()
  }

  @objc func selectNone(_ sender: Any?) {
    session.selectNone()
    viewStateChanged()
  }

  @objc func hidePieces(_ sender: Any?) {
    guard hasSelection else { return NSSound.beep() }
    session.hide(selection)
    session.selectNone()
    viewStateChanged()
  }

  @objc func hideOtherPieces(_ sender: Any?) {
    guard hasSelection else { return NSSound.beep() }
    let chosen = Set(selection.map { $0 })
    let others = (0..<UInt32(session.pieceCount())).filter { !chosen.contains($0) }
    session.hide(Self.list(others))
    viewStateChanged()
  }

  @objc func showAllPieces(_ sender: Any?) {
    session.showAll()
    viewStateChanged()
  }

  @objc func fitAll(_ sender: Any?) {
    viewport.fitAll()
    changed()
  }

  @objc func frameSelection(_ sender: Any?) {
    viewport.frameSelection()
    changed()
  }

  // MARK: Keys

  /// The editing keys without ⌘ (the menus have those). True when the key was used.
  func editKey(_ event: NSEvent) -> Bool {
    let flags = event.modifierFlags.intersection([.shift, .option, .control, .command])
    guard !flags.contains(.command) else { return false }
    let shift = flags.contains(.shift), option = flags.contains(.option), control = flags.contains(.control)
    let height = option ? bmapp.kBrick : bmapp.kPlate
    let up = bmapp.Vec3(x: 0, y: -height, z: 0), down = bmapp.Vec3(x: 0, y: height, z: 0)

    if let special = event.specialKey {
      switch special {
      case .leftArrow: nudgeAlong(.Left)
      case .rightArrow: nudgeAlong(.Right)
      case .upArrow: shift ? nudge(up) : nudgeAlong(.Up)
      case .downArrow: shift ? nudge(down) : nudgeAlong(.Down)
      case .pageUp: nudge(up)
      case .pageDown: nudge(down)
      case .delete, .deleteForward, .backspace: deletePieces(nil)
      default: return false
      }
      return true
    }
    guard let key = event.charactersIgnoringModifiers?.lowercased() else { return false }
    switch key {
    case "\u{1b}": selectNone(nil)
    case "e": nudge(up)
    case "q": nudge(down)
    case "r": turn(clockwise: !shift)
    case "c": clonePieces(nil)
    case "h":
      if option { hideOtherPieces(nil) } else if shift { showAllPieces(nil) } else { hidePieces(nil) }
    case "a": option ? selectNone(nil) : selectAll(nil)
    case "f": fitAll(nil)
    case "1": viewport.view(control ? .Back : .Front)
    case "3": viewport.view(control ? .Left : .Right)
    case "7": viewport.view(control ? .Bottom : .Top)
    default: return false
    }
    changed()
    return true
  }

  private func nudgeAlong(_ arrow: bmapp.Arrow) {
    let axis = bmapp.arrowAxis(viewport.camera(), arrow)
    nudge(bmapp.Vec3(x: axis.x * bmapp.kStud, y: 0, z: axis.z * bmapp.kStud))
  }

  // MARK: Menu validation

  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    guard document != nil else { return false }
    switch item.action {
    case #selector(deletePieces(_:)), #selector(delete(_:)), #selector(duplicatePieces(_:)), #selector(copy(_:)), #selector(cut(_:)),
         #selector(rotatePieces(_:)), #selector(rotatePiecesBack(_:)), #selector(raisePieces(_:)), #selector(lowerPieces(_:)),
         #selector(replacePart(_:)), #selector(hidePieces(_:)), #selector(hideOtherPieces(_:)), #selector(frameSelection(_:)),
         #selector(selectNone(_:)):
      return hasSelection
    case #selector(paste(_:)): return Pasteboard.canPaste
    case #selector(makeUnique(_:)):
      let snap = session.snapshot()
      return snap.selected.size() == 1 && snap.selected[0].inSharedSubmodel
    case #selector(showAllPieces(_:)): return session.snapshot().hidden > 0
    case #selector(selectAll(_:)): return session.pieceCount() > 0
    default: return true
    }
  }
}
