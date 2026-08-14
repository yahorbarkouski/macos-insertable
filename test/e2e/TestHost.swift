/// A minimal AppKit application the end-to-end tests aim real insertions at.
///
/// One window, one focused control, chosen by argument:
///   textview    — NSTextView (multiline, readable AX surface)
///   textfield   — NSTextField (single-line)
///   securefield — NSSecureTextField (must classify as a secure field, never receive text)
///   button      — NSButton (focused, but nowhere text can go)
///
/// Writes "READY <pid>" to the file given as the second argument once frontmost with the control
/// focused (stdout is detached when launched through `open`), then serves until killed. Never
/// reads or writes anything outside its own window and that file.

import AppKit

final class HostDelegate: NSObject, NSApplicationDelegate {
  let mode: String
  let readyPath: String?
  var window: NSWindow!

  init(mode: String, readyPath: String?) {
    self.mode = mode
    self.readyPath = readyPath
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    // A bare AppKit app has no menu bar, and menu key equivalents are how ⌘V becomes paste: —
    // without an Edit menu the chord arrives and silently does nothing, which every real
    // application (all of which have Edit menus) would not do.
    let mainMenu = NSMenu()
    let editItem = NSMenuItem()
    mainMenu.addItem(editItem)
    let editMenu = NSMenu(title: "Edit")
    editItem.submenu = editMenu
    editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(
      withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    NSApp.mainMenu = mainMenu

    let frame = NSRect(x: 200, y: 200, width: 480, height: 220)
    window = NSWindow(
      contentRect: frame,
      styleMask: [.titled, .closable],
      backing: .buffered,
      defer: false
    )
    window.title = "macos-insertable test host (\(mode))"

    let control: NSView
    switch mode {
    case "textview":
      let scroll = NSScrollView(frame: NSRect(x: 20, y: 20, width: 440, height: 180))
      let text = NSTextView(frame: scroll.bounds)
      text.isRichText = false
      text.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
      scroll.documentView = text
      control = scroll
      window.contentView?.addSubview(scroll)
      window.makeFirstResponder(text)
    case "textfield":
      let field = NSTextField(frame: NSRect(x: 20, y: 90, width: 440, height: 24))
      field.placeholderString = "Host field"
      control = field
      window.contentView?.addSubview(field)
      window.makeFirstResponder(field)
    case "securefield":
      let field = NSSecureTextField(frame: NSRect(x: 20, y: 90, width: 440, height: 24))
      field.placeholderString = "Host secure field"
      control = field
      window.contentView?.addSubview(field)
      window.makeFirstResponder(field)
    case "button":
      let button = NSButton(frame: NSRect(x: 20, y: 90, width: 200, height: 32))
      button.title = "Host button"
      control = button
      window.contentView?.addSubview(button)
      window.makeFirstResponder(button)
    default:
      FileHandle.standardError.write("unknown mode \(mode)\n".data(using: .utf8)!)
      exit(2)
    }
    _ = control

    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)

    // READY only once actually frontmost: the library's delivery path refuses a target that is
    // not the frontmost application, so announcing earlier races the activation. The timer then
    // keeps re-asserting activation for the host's short life — rapid successive test launches
    // trip macOS focus-stealing prevention, which snaps focus back to the previous app moments
    // after this one is announced frontmost.
    var announced = false
    Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [self] _ in
      let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier
      if frontmost == ProcessInfo.processInfo.processIdentifier {
        if !announced {
          announced = true
          let line = "READY \(ProcessInfo.processInfo.processIdentifier)\n"
          if let readyPath {
            try? line.write(toFile: readyPath, atomically: true, encoding: .utf8)
          }
          print(line, terminator: "")
          fflush(stdout)
        }
      } else {
        NSApp.activate(ignoringOtherApps: true)
      }
    }
  }
}

// A leaked host is toxic: its reactivation loop fights every later test for focus. The dead-man
// timer guarantees no instance outlives a stuck suite.
DispatchQueue.main.asyncAfter(deadline: .now() + 90) { exit(0) }

// `open --args` forwards exactly what follows it, so argv is [binary, mode, readyPath].
let mode = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "textview"
let readyPath = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : nil
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = HostDelegate(mode: mode, readyPath: readyPath)
app.delegate = delegate
app.run()
