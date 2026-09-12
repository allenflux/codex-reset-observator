import AppKit

let size = 1024
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
                             bitsPerSample: 8, samplesPerPixel: 3, hasAlpha: false,
                             isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor(red: 0.045, green: 0.075, blue: 0.085, alpha: 1).setFill()
NSBezierPath(rect: NSRect(x: 0, y: 0, width: size, height: size)).fill()
for diameter in [720.0, 520.0] {
    NSColor(red: 0.18, green: 0.29, blue: 0.27, alpha: 1).setStroke()
    let ring = NSBezierPath(ovalIn: NSRect(x: (1024 - diameter) / 2, y: (1024 - diameter) / 2,
                                         width: diameter, height: diameter))
    ring.lineWidth = 6
    ring.stroke()
}
let mint = NSColor(red: 0.55, green: 0.92, blue: 0.73, alpha: 1)
mint.setStroke()
let pulse = NSBezierPath()
pulse.move(to: NSPoint(x: 214, y: 498))
for point in [NSPoint(x: 364, y: 498), NSPoint(x: 438, y: 684), NSPoint(x: 545, y: 340), NSPoint(x: 625, y: 528), NSPoint(x: 810, y: 528)] {
    pulse.line(to: point)
}
pulse.lineWidth = 46
pulse.lineCapStyle = .round
pulse.lineJoinStyle = .round
pulse.stroke()
mint.setFill()
NSBezierPath(ovalIn: NSRect(x: 738, y: 726, width: 66, height: 66)).fill()
NSGraphicsContext.restoreGraphicsState()
let output = CommandLine.arguments.dropFirst().first ?? "ios/ResetObservatory/Assets.xcassets/AppIcon.appiconset/AppIcon.png"
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
