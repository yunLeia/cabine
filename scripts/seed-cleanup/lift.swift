import Foundation
import Vision
import CoreImage
import ImageIO
import UniformTypeIdentifiers

// Usage: lift <input> <outdir>. Writes one PNG per detected foreground instance, plus all.png.
let args = CommandLine.arguments
let url = URL(fileURLWithPath: args[1])
let outDir = URL(fileURLWithPath: args[2])
let name = url.deletingPathExtension().lastPathComponent
let ci = CIImage(contentsOf: url)!
let handler = VNImageRequestHandler(ciImage: ci)
let req = VNGenerateForegroundInstanceMaskRequest()
try handler.perform([req])
guard let obs = req.results?.first else { print("\(name): no subject"); exit(0) }
let ctx = CIContext()
func write(_ set: IndexSet, _ suffix: String) throws {
  let buf = try obs.generateMaskedImage(ofInstances: set, from: handler, croppedToInstancesExtent: true)
  let img = CIImage(cvPixelBuffer: buf)
  let dest = outDir.appendingPathComponent("\(name)-\(suffix).png")
  try ctx.writePNGRepresentation(of: img, to: dest, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
}
print("\(name): \(obs.allInstances.count) instance(s)")
for i in obs.allInstances { try write(IndexSet(integer: i), "i\(i)") }
try write(obs.allInstances, "all")
