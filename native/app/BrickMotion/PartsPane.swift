import SwiftUI

struct PartsPane: View {
  @Bindable var model: DocumentModel
  @State private var library: PartsCatalog.Library?
  @State private var categories: [String]?
  @State private var results: [LibraryPart] = []
  @State private var displayedFilter: Filter?
  @State private var showColours = false
  @FocusState private var searchFocused: Bool

  private let pageSize = 96

  private struct Filter: Equatable {
    let query: String
    let category: String?
    var isCommon: Bool { query.isEmpty && category == nil }
  }

  private var filter: Filter {
    Filter(query: model.partsQuery.trimmingCharacters(in: .whitespacesAndNewlines), category: model.partsCategory)
  }

  private var shown: [LibraryPart] {
    if filter.isCommon {
      switch model.partsCollection {
      case .common: return library?.common ?? []
      case .frequent: return PartsHistory.shared.frequent
      case .recent: return PartsHistory.shared.recent
      }
    }
    return displayedFilter == filter ? results : []
  }

  var body: some View {
    VStack(spacing: 0) {
      controls
      Divider()
      content
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      if let part = model.browsedPart, shown.contains(where: { $0.id == part.id }) {
        Divider()
        detail(part)
      }
    }
    .task {
      let catalog = await PartsCatalog.shared.library()
      guard !Task.isCancelled else { return }
      library = catalog
      let names = await PartsCatalog.shared.categories(in: catalog.directory)
      guard !Task.isCancelled else { return }
      categories = names
    }
    .task(id: searchRequest) {
      guard let catalog = library, let request = searchRequest else { return }
      await search(request, in: catalog)
    }
  }

  private struct SearchRequest: Equatable {
    let filter: Filter
    let pages: Int
  }

  private var searchRequest: SearchRequest? {
    guard library != nil, !filter.isCommon else { return nil }
    return SearchRequest(filter: filter, pages: model.partsPages)
  }

  private var controls: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Image(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
        TextField("Search parts", text: $model.partsQuery)
          .textFieldStyle(.plain)
          .focused($searchFocused)
          .onSubmit { if let first = shown.first { model.beginPlacement(first) } }
        if !model.partsQuery.isEmpty {
          Button { model.partsQuery = "" } label: {
            Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Clear search")
        }
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 7)
      .background(.quaternary, in: .rect(cornerRadius: 7))
      .overlay {
        if searchFocused {
          RoundedRectangle(cornerRadius: 7).strokeBorder(Color.accentColor, lineWidth: 1.5).allowsHitTesting(false)
        }
      }
      HStack(spacing: 6) {
        Picker("Category", selection: $model.partsCategory) {
          Text("All Categories").tag(nil as String?)
          ForEach(categories ?? [], id: \.self) { Text($0).tag(Optional($0)) }
        }
        .labelsHidden()
        .disabled(categories?.isEmpty ?? true)
        .frame(maxWidth: .infinity)
        Button { showColours = true } label: {
          if let info = model.colors[model.partColour] {
            Swatch(info: info, size: 14)
          } else {
            Image(systemName: "paintpalette")
          }
        }
        .help("Choose the colour for new parts")
        .accessibilityLabel("New part colour")
        .popover(isPresented: $showColours, arrowEdge: .trailing) {
          ColorSwatches(swatches: ColorSwatchesModel(model: model, target: .placement))
        }
        Menu {
          Picker("Initial Turn", selection: $model.partTurns) {
            ForEach(0..<4) { Text("\($0 * 90)°").tag($0) }
          }
          Toggle("Mirror Part", isOn: $model.partMirrored)
          Toggle("Use LDraw Placement Examples", isOn: $model.partReferenceHints)
        } label: {
          Label("Placement Options", systemImage: "slider.horizontal.3").labelStyle(.iconOnly)
        }
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Placement options")
      }
      if filter.isCommon {
        Picker("Collection", selection: $model.partsCollection) {
          ForEach(DocumentModel.PartsCollection.allCases, id: \.self) { Text($0.rawValue).tag($0) }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
      }
    }
    .padding(10)
  }

  @ViewBuilder private var content: some View {
    if categories?.isEmpty == true {
      unavailable("No Parts Library", symbol: "externaldrive", description: "The LDraw library could not be read.")
    } else if library == nil || (filter.isCommon && shown.isEmpty && categories == nil) ||
                (!filter.isCommon && displayedFilter != filter) {
      ProgressView().controlSize(.small).accessibilityLabel("Loading parts")
    } else if shown.isEmpty {
      if filter.isCommon {
        switch model.partsCollection {
        case .common:
          unavailable("No Common Parts", symbol: "square.grid.2x2", description: "Search this library by name or part number.")
        case .frequent:
          unavailable("No Frequent Parts", symbol: "arrow.clockwise", description: "Parts you place more than once appear here.")
        case .recent:
          unavailable("No Recent Parts", symbol: "clock", description: "Parts you place appear here.")
        }
      } else {
        VStack(spacing: 0) {
          unavailable("No Matching Parts", symbol: "magnifyingglass",
                      description: "Try a part number or a shorter name.")
          if model.partsCategory != nil {
            Button("Search All Categories") { model.partsCategory = nil }
          }
        }
      }
    } else {
      ScrollView {
        VStack(alignment: .leading, spacing: 8) {
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 86), spacing: 8)], spacing: 8) {
            ForEach(shown.prefix(pageSize * model.partsPages)) { part in
              PartTile(part: part, selected: model.browsedPart?.id == part.id, colour: model.partColour) {
                model.beginPlacement(part)
              }
              .onDrag { model.dragItem(part).provider() }
            }
          }
          .scrollTargetLayout()
          if shown.count > pageSize * model.partsPages {
            Button("Show More Parts") { model.partsPages += 1 }
              .frame(maxWidth: .infinity)
          }
        }
        .padding(10)
      }
      .scrollPosition(id: $model.partsScrollTarget)
    }
  }

  private func detail(_ part: LibraryPart) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(part.name)
        .font(.subheadline.weight(.semibold))
        .lineLimit(3)
      Text("\(part.category) · \(part.number)")
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(10)
  }

  private func unavailable(_ title: String, symbol: String, description: String) -> some View {
    VStack(spacing: 5) {
      Image(systemName: symbol).font(.title3).foregroundStyle(.secondary).accessibilityHidden(true)
      Text(title).font(.subheadline.weight(.semibold))
      Text(description).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
    }
    .padding(16)
  }

  private func search(_ request: SearchRequest, in library: PartsCatalog.Library) async {
    let matches = await PartsCatalog.shared.search(in: library.directory, query: request.filter.query,
                                                   category: request.filter.category, limit: pageSize * request.pages + 1)
    guard !Task.isCancelled, request == searchRequest else { return }
    results = matches
    displayedFilter = request.filter
  }
}
