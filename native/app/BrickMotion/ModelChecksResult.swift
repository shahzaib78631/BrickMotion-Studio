import BMApp

struct ModelChecksResult: Sendable {
  enum Kind: String, Sendable, CaseIterable, Identifiable {
    case overlap = "Overlaps"
    case unsupported = "Unsupported Parts"
    case tipping = "Unstable Groups"
    case singleConnector = "Single-Connector Attachments"
    case missingDefinition = "Missing Definitions"
    case unknownColour = "Unknown Colours"
    case submodelLoop = "Submodel Loops"

    var id: Self { self }

    init?(native: bmapp.ModelCheckKind) {
      switch native {
      case .Overlap: self = .overlap
      case .Unsupported: self = .unsupported
      case .Tipping: self = .tipping
      case .SingleConnector: self = .singleConnector
      case .MissingDefinition: self = .missingDefinition
      case .UnknownColour: self = .unknownColour
      case .SubmodelLoop: self = .submodelLoop
      default: return nil
      }
    }
  }

  struct Finding: Sendable, Identifiable {
    let id: Int
    let kind: Kind
    let title, detail: String
    let pieces: [UInt32]
  }

  let findings: [Finding]
  let error: String
}
