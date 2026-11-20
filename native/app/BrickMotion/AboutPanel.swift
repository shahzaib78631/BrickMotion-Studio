import AppKit
import BMApp

@MainActor enum AboutPanel {
  static func show() {
    let engine = String(bmapp.Session.engineVersion())
    NSApp.orderFrontStandardAboutPanel(options: [
      .version: "Engine \(engine)",
      .credits: NSAttributedString(string: "Parts and colours from the LDraw Parts Library.\nConnections from LDCad Shadow Library, BrickNet, and BrickLink Studio data when installed.")
    ])
  }
}
