// Checks a --snapshot picture: its size, a viewport full of model, and a sidebar that is not flat.
// usage: swift snapshot_check.swift <BrickMotion binary> <model> <out dir>
import CoreGraphics
import Foundation
import ImageIO

let args = CommandLine.arguments
guard args.count == 4 else { print("usage: snapshot_check <binary> <model> <outdir>"); exit(2) }
let png = URL(fileURLWithPath: args[3]).appendingPathComponent("snapshot.png")
let report = URL(fileURLWithPath: args[3]).appendingPathComponent("snapshot.json")
try? FileManager.default.removeItem(at: png)

let run = Process()
run.executableURL = URL(fileURLWithPath: args[1])
run.arguments = ["--snapshot", png.path, "--open", args[2], "--size", "1440x900", "--report", report.path]
try run.run()
run.waitUntilExit()
guard run.terminationStatus == 0 else { print("FAIL: exit \(run.terminationStatus)"); exit(1) }

guard let source = CGImageSourceCreateWithURL(png as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
  print("FAIL: no picture"); exit(1)
}
var failed = false
func check(_ ok: Bool, _ what: String) { print((ok ? "ok   " : "FAIL ") + what); if !ok { failed = true } }
check(image.width == 2880 && image.height == 1800, "size \(image.width)x\(image.height) is 2880x1800")

let data = try Data(contentsOf: report)
let rects = try JSONSerialization.jsonObject(with: data) as! [String: [Double]]
let ctx = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
let pixels = ctx.data!.bindMemory(to: UInt8.self, capacity: image.width * image.height * 4)
/// Distinct colours inside a rect given as [x, y, w, h] in pixels from the top left.
func colours(_ r: [Double]) -> Int {
  var seen = Set<UInt32>()
  for y in Int(r[1])..<Int(r[1] + r[3]) where y >= 0 && y < image.height {
    for x in Int(r[0])..<Int(r[0] + r[2]) where x >= 0 && x < image.width {
      let i = (y * image.width + x) * 4  // CGContext rows run top to bottom in memory
      seen.insert(UInt32(pixels[i]) << 16 | UInt32(pixels[i + 1]) << 8 | UInt32(pixels[i + 2]))
    }
  }
  return seen.count
}
let viewport = rects["viewport"] ?? [0, 0, 0, 0], sidebar = rects["sidebar"] ?? [0, 0, 0, 0]
let vc = colours(viewport), sc = colours(sidebar)
check(vc > 1000, "viewport has \(vc) colours (> 1000)")
check(sc > 1, "sidebar has \(sc) colours (not flat)")
exit(failed ? 1 : 0)
