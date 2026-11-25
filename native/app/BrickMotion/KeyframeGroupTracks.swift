import AppKit
import BMApp
import SwiftUI

struct KeyframeGroupTracks<Ruler: View, Header: View>: View {
  private struct Pick: Hashable {
    let object: KeyframeTracks.Object.ID
    let frame: Int32
  }

  let objects: [KeyframeTracks.Object]
  let model: DocumentModel
  let navigation: TimelineNavigation
  let playing: Bool
  let first, last, frame: Int32
  let labelWidth: CGFloat
  let seek: (Int32) -> Void
  let play: () -> Void
  /// What runs above the rows, across the time area (the frame ruler and the Camera lane), and
  /// its label; `rulerHeight` tall.
  let rulerHeight: CGFloat
  @ViewBuilder let ruler: (TimelineScale) -> Ruler
  @ViewBuilder let header: () -> Header
  @State private var selection: Set<Pick> = []
  @State private var drag: (picks: Set<Pick>, limits: ClosedRange<Int32>, offset: Int32)?
  @State private var marquee: CGRect?
  @State private var visibleRows = 0..<16
  @FocusState private var editingKeys: Bool
  private let rowHeight: CGFloat = 28
  private var duration: Double { Double(last - first) }
  private var visible: Range<Int> {
    min(objects.count, visibleRows.lowerBound)..<min(objects.count, visibleRows.upperBound)
  }

  var body: some View {
    ScrollView(.vertical) {
      HStack(alignment: .top, spacing: 0) {
        labels
        Divider().frame(height: rulerHeight + CGFloat(objects.count) * rowHeight)
        TimelineTrackArea(navigation: navigation, duration: duration, playhead: { Double(frame - first) }, playing: playing) { scale in
          grid(scale)
        }
      }
    }
    .onScrollGeometryChange(for: Range<Int>.self) { geometry in
      let top = geometry.contentOffset.y + geometry.contentInsets.top
      let lower = max(0, Int(floor((top - rulerHeight) / rowHeight)) - 3)
      let upper = max(lower, Int(ceil((top + geometry.containerSize.height - rulerHeight) / rowHeight)) + 3)
      return lower..<upper
    } action: { _, rows in
      visibleRows = rows
    }
    .accessibilityLabel("Selected object keyframes")
    .onChange(of: objects.map(\.id)) { selection.removeAll() }
    .onChange(of: model.snapshot.version) {
      let available = Set(objects.flatMap { row in row.markers.map { Pick(object: row.id, frame: $0.frame) } })
      selection.formIntersection(available)
    }
  }

  private var labels: some View {
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 0) {
        Text("\(objects.count) Objects")
          .font(.caption.weight(.semibold)).foregroundStyle(.secondary).frame(height: 24)
        header()
      }
      .frame(height: rulerHeight, alignment: .top)
      rowSpacer(visible.lowerBound)
      ForEach(visible, id: \.self) { index in
        let row = objects[index]
        Text(row.name)
          .font(.callout).lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading).frame(height: rowHeight)
          .help(row.name)
          .overlay(alignment: .bottom) { Divider() }
      }
      rowSpacer(objects.count - visible.upperBound)
    }
    .padding(.horizontal, 9)
    .frame(width: labelWidth, alignment: .leading)
    .background(.bar)
  }

  private func rowSpacer(_ count: Int) -> some View {
    Color.clear.frame(height: CGFloat(count) * rowHeight).allowsHitTesting(false).accessibilityHidden(true)
  }

  private func grid(_ scale: TimelineScale) -> some View {
    VStack(spacing: 0) {
      ruler(scale)
      rowSpacer(visible.lowerBound)
      ForEach(Array(visible), id: \.self) { index in
        track(index, scale: scale)
      }
      rowSpacer(objects.count - visible.upperBound)
    }
    .frame(width: scale.width)
    .coordinateSpace(name: "ObjectKeyframeGrid")
    .focusable()
    .focused($editingKeys)
    .onDeleteCommand { delete(selection) }
    .onCommand(#selector(NSText.selectAll(_:))) {
      selection = Set(objects.flatMap { row in row.markers.map { Pick(object: row.id, frame: $0.frame) } })
    }
    .onKeyPress(.space) { play(); return .handled }
    .onKeyPress(keys: [.leftArrow, .rightArrow]) { event in
      if !event.modifiers.intersection([.command, .control, .option]).isEmpty { return .ignored }
      let stride: Int32 = event.modifiers.contains(.shift) ? 10 : 1
      let next = frame + (event.key == .leftArrow ? -stride : stride)
      seek(min(last, max(first, next)))
      return .handled
    }
    .overlay(alignment: .topLeading) {
      Rectangle().fill(Color.accentColor).frame(width: 1)
        .offset(x: scale.x(Double(frame - first))).allowsHitTesting(false)
      if let marquee {
        Rectangle().fill(Color.accentColor.opacity(0.12))
          .overlay { Rectangle().strokeBorder(Color.accentColor.opacity(0.85)) }
          .frame(width: marquee.width, height: marquee.height)
          .offset(x: marquee.minX, y: marquee.minY)
          .allowsHitTesting(false)
          .accessibilityHidden(true)
      }
    }
  }

  private func track(_ index: Int, scale: TimelineScale) -> some View {
    let row = objects[index]
    let background = index.isMultiple(of: 2) ? Color.primary.opacity(0.027) : Color.clear
    return ZStack(alignment: .leading) {
      Rectangle().fill(background).contentShape(.rect).gesture(selectRectangle(scale))
      ForEach(visibleMarkers(row)) { marker in
        markerButton(marker, object: row, scale: scale)
      }
    }
    .frame(height: rowHeight)
    .overlay(alignment: .bottom) { Divider() }
  }

  private func visibleMarkers(_ object: KeyframeTracks.Object) -> [KeyframeTracks.Object.Marker] {
    let margin = duration * 18 / max(1, navigation.logicalWidth)
    let start = Double(first) + navigation.visibleStart * duration - margin
    let end = Double(first) + navigation.visibleEnd * duration + margin
    return object.markers.filter { marker in
      let frame = Double(marker.frame)
      return (frame >= start && frame <= end) || drag?.picks.contains(Pick(object: object.id, frame: marker.frame)) == true
    }
  }

  private func markerButton(_ marker: KeyframeTracks.Object.Marker, object: KeyframeTracks.Object,
                            scale: TimelineScale) -> some View {
    let pick = Pick(object: object.id, frame: marker.frame)
    let picked = selection.contains(pick)
    let preview = drag?.picks.contains(pick) == true ? drag?.offset ?? 0 : 0
    return Button {
      editingKeys = true
      if extendsSelection {
        if !selection.insert(pick).inserted { selection.remove(pick) }
      } else {
        selection = [pick]
      }
      seek(pick.frame)
    } label: {
      Image(systemName: marker.channels > 1 ? "diamond.inset.filled" : "diamond.fill")
        .font(.system(size: 9))
        .foregroundStyle(picked ? .orange : marker.frame == frame ? .primary : Color.accentColor)
        .frame(width: 18, height: rowHeight)
        .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .offset(x: scale.x(Double(marker.frame + preview - first)) - 9)
    .accessibilityLabel("\(object.name), frame \(marker.frame), \(marker.channels) keyed properties")
    .accessibilityAddTraits(picked ? .isSelected : [])
    .contextMenu {
      let picks = selection.contains(pick) ? selection : [pick]
      Button("Move to Playhead") { move(picks, offset: frame - pick.frame, from: pick.frame) }
        .disabled(frame == pick.frame)
      Divider()
      Button(picks.count == 1 ? "Delete Keys at Frame" : "Delete Keys at Selected Frames", role: .destructive) {
        delete(picks)
      }
    }
    .simultaneousGesture(DragGesture(minimumDistance: 4, coordinateSpace: .global).onChanged { value in
      let picks = drag?.picks ?? (selection.contains(pick) ? selection : [pick])
      let limits = drag?.limits ?? offsets(for: picks)
      let delta = Int32((value.translation.width * duration / scale.width).rounded())
      drag = (picks, limits, min(limits.upperBound, max(limits.lowerBound, delta)))
    }.onEnded { _ in
      guard let pending = drag else { return }
      drag = nil
      move(pending.picks, offset: pending.offset, from: pick.frame)
    })
  }

  private var extendsSelection: Bool {
    let modifiers = NSApp.currentEvent?.modifierFlags ?? []
    return modifiers.contains(.shift) || modifiers.contains(.command)
  }

  private func selectRectangle(_ scale: TimelineScale) -> some Gesture {
    DragGesture(minimumDistance: 5, coordinateSpace: .named("ObjectKeyframeGrid")).onChanged { event in
      marquee = CGRect(x: min(event.startLocation.x, event.location.x), y: min(event.startLocation.y, event.location.y),
                       width: abs(event.translation.width), height: abs(event.translation.height))
    }.onEnded { _ in
      guard let bounds = marquee?.insetBy(dx: -4, dy: -4) else { return }
      marquee = nil
      editingKeys = true
      var result: Set<Pick> = []
      for (index, row) in objects.enumerated() {
        let y = rulerHeight + (CGFloat(index) + 0.5) * rowHeight
        guard y >= bounds.minY, y <= bounds.maxY else { continue }
        for marker in row.markers {
          let x = scale.x(Double(marker.frame - first))
          if bounds.contains(CGPoint(x: x, y: y)) { result.insert(Pick(object: row.id, frame: marker.frame)) }
        }
      }
      if extendsSelection { selection.formUnion(result) } else { selection = result }
    }
  }

  private func offsets(for picks: Set<Pick>) -> ClosedRange<Int32> {
    guard let earliest = picks.min(by: { $0.frame < $1.frame }), let latest = picks.max(by: { $0.frame < $1.frame })
    else { return 0...0 }
    return (first - earliest.frame)...(last - latest.frame)
  }

  private func move(_ picks: Set<Pick>, offset: Int32, from anchor: Int32) {
    let limits = offsets(for: picks)
    let delta = min(limits.upperBound, max(limits.lowerBound, offset))
    guard delta != 0, model.context.perform({ $0.moveKeyRows(nativePicks(picks), delta) }) else { return }
    selection = Set(picks.map { Pick(object: $0.object, frame: $0.frame + delta) })
    seek(anchor + delta)
  }

  private func delete(_ picks: Set<Pick>) {
    guard !picks.isEmpty else { return }
    if model.context.perform({ $0.removeKeyRows(nativePicks(picks)) }) { selection.subtract(picks) }
  }

  private func nativePicks(_ picks: Set<Pick>) -> bmapp.KeyRowPicks {
    var native = bmapp.KeyRowPicks()
    for pick in picks {
      native.push_back(bmapp.KeyRowPick(piece: pick.object.piece, frame: pick.frame, submodel: pick.object.submodel))
    }
    return native
  }
}
