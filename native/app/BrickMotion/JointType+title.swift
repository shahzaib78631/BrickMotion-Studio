import BMApp

extension bmapp.JointType {
  var title: String {
    switch self {
    case .Fixed: "Fixed"
    case .Hinge: "Hinge"
    case .Slider: "Slider"
    case .Cylindrical: "Turn and Slide"
    case .Ball: "Ball Joint"
    case .Flexible: "Flexible"
    default: "Connection"
    }
  }
}
