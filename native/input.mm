#import "input.h"
#import "napi_support.h"
#import "system.h"

#import <Carbon/Carbon.h>
#import <CoreGraphics/CoreGraphics.h>

#include <algorithm>
#include <string>
#include <unistd.h>
#include <utility>
#include <vector>

namespace insertable {

namespace {

constexpr CGKeyCode kKeyCodeV = 0x09;

constexpr CGKeyCode kKeyCodeDelete = 0x33;

constexpr CGKeyCode kKeyCodeReturn = 0x24;

constexpr CGKeyCode kKeyCodeCommand = 0x37;

constexpr CGKeyCode kKeyCodeShift = 0x38;

constexpr CGKeyCode kNoModifierKey = 0xFFFF;

constexpr CFIndex kTypeChunkUnits = 16;

constexpr size_t kMaxTypeUnits = 2000;

constexpr useconds_t kTypeChunkDelayUs = 1200;

class TypeUnicodeWorker : public PromiseWorker {
 public:
  TypeUnicodeWorker(Napi::Env env, pid_t expectedPid, std::vector<UniChar> units)
      : PromiseWorker(env), expectedPid_(expectedPid), units_(std::move(units)) {}

  void Execute() override {
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    for (size_t offset = 0; offset < units_.size(); offset += kTypeChunkUnits) {
      size_t count = std::min(static_cast<size_t>(kTypeChunkUnits), units_.size() - offset);
      CGEventRef down = CGEventCreateKeyboardEvent(source, 0, true);
      CGEventRef up = CGEventCreateKeyboardEvent(source, 0, false);
      if (!down || !up) {
        if (down) CFRelease(down);
        if (up) CFRelease(up);
        ok_ = false;
        break;
      }
      // Flags left over from a still-settling hotkey chord would turn typed characters into
      // shortcuts; a Unicode payload never wants modifiers.
      CGEventSetFlags(down, static_cast<CGEventFlags>(0));
      CGEventSetFlags(up, static_cast<CGEventFlags>(0));
      CGEventKeyboardSetUnicodeString(down, static_cast<UniCharCount>(count), &units_[offset]);
      CGEventKeyboardSetUnicodeString(up, static_cast<UniCharCount>(count), &units_[offset]);
      CGEventPostToPid(expectedPid_, down);
      CGEventPostToPid(expectedPid_, up);
      CFRelease(down);
      CFRelease(up);
      usleep(kTypeChunkDelayUs);
    }
    if (source) CFRelease(source);
  }

  void OnOK() override {
    bool remainedFrontmost = FocusedAppPid() == expectedPid_;
    deferred_.Resolve(Napi::Boolean::New(Env(), ok_ && remainedFrontmost));
  }

 private:
  pid_t expectedPid_;
  std::vector<UniChar> units_;
  bool ok_ = true;
};

bool PostKeyEvent(CGEventSourceRef source, pid_t pid, CGKeyCode keyCode, bool keyDown,
                  CGEventFlags flags) {
  CGEventRef event = CGEventCreateKeyboardEvent(source, keyCode, keyDown);
  if (!event) return false;
  // Set rather than or-in: any modifier the user still physically holds would otherwise turn this
  // into a different shortcut.
  CGEventSetFlags(event, flags);
  CGEventPostToPid(pid, event);
  CFRelease(event);
  return true;
}

/**
 * Posts one keystroke, optionally wrapped in real modifier key events, while `expectedPid` is
 * frontmost.
 *
 * The frontmost check proves the target still matches the caller's captured intent. The events
 * are then addressed to that process rather than the session stream, so a focus change cannot
 * reroute text into a different application. macOS may drop a process-targeted event after its
 * app loses focus; the final check reports that as a failed delivery, which is safer than
 * misdirection.
 *
 * A modifier is delivered as its own key event and not only as a flag on the keystroke. Toolkits
 * that track modifiers through the events they receive — Chromium, and every Electron application
 * on top of it — never observe Command going down otherwise, and handle the keystroke as a bare
 * "v": the paste silently becomes a typed letter. No wall-clock hold accompanies it, because
 * these events are addressed to the process and consumed from its own queue in order; a hold
 * would only matter for an application polling the system-wide modifier state, which posting to a
 * pid never sets in the first place.
 */
bool PostKeyToFrontmost(pid_t expectedPid, CGKeyCode keyCode, CGKeyCode modifierKeyCode,
                        CGEventFlags flags) {
  if (FocusedAppPid() != expectedPid) return false;

  CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
  bool modifierHeld = false;
  if (modifierKeyCode != kNoModifierKey) {
    modifierHeld = PostKeyEvent(source, expectedPid, modifierKeyCode, true, flags);
  }
  bool ok = modifierKeyCode == kNoModifierKey || modifierHeld;
  if (ok) ok = PostKeyEvent(source, expectedPid, keyCode, true, flags);
  if (ok) ok = PostKeyEvent(source, expectedPid, keyCode, false, flags);
  // Released even when the keystroke failed: an application that saw the press and never the
  // release holds Command down against every key the user types next.
  if (modifierHeld) {
    PostKeyEvent(source, expectedPid, modifierKeyCode, false, static_cast<CGEventFlags>(0));
  }
  if (source) CFRelease(source);
  if (!ok) return false;
  // A focus change means the target may have dropped the addressed events.
  return FocusedAppPid() == expectedPid;
}

/**
 * The virtual keycode that produces `wanted` on the CURRENT keyboard layout.
 *
 * Physical keycode 9 is only "V" on QWERTY-shaped layouts. Layouts in the "— QWERTY ⌘" family
 * remap to QWERTY while Command is held, so for them the physical code is right — but on plain
 * Dvorak or Colemak, keycode 9 under Command is ⌘K/⌘…, a different (possibly destructive)
 * command. The two families need opposite answers, so: QWERTY-⌘ variants (input source id
 * carries "QWERTYCMD") keep the physical code, everything else resolves the character through
 * UCKeyTranslate over the layout's own mapping.
 *
 * Resolved fresh per chord rather than cached: a cache would need a layout-change observer, and
 * observers need a serviced run loop this library deliberately does not require. Measured cost —
 * 4µs per steady-state call (128 keycodes, entirely in-process), behind a one-time ~47ms of Text
 * Input Source subsystem initialization on the first call in a process. That first-call cost
 * lands on the first paste of a session; any TSM use would pay it, and a caller who cares can
 * spend it early by resolving once at startup.
 */
CGKeyCode KeyCodeForChar(UniChar wanted, CGKeyCode physicalFallback) {
  TISInputSourceRef layout = TISCopyCurrentKeyboardLayoutInputSource();
  if (!layout) return physicalFallback;

  CFStringRef sourceId =
      static_cast<CFStringRef>(TISGetInputSourceProperty(layout, kTISPropertyInputSourceID));
  if (sourceId && CFStringFind(sourceId, CFSTR("QWERTYCMD"), kCFCompareCaseInsensitive).location !=
                      kCFNotFound) {
    CFRelease(layout);
    return physicalFallback;
  }

  CFDataRef layoutData =
      static_cast<CFDataRef>(TISGetInputSourceProperty(layout, kTISPropertyUnicodeKeyLayoutData));
  CGKeyCode resolved = physicalFallback;
  if (layoutData) {
    const UCKeyboardLayout* keyboardLayout =
        reinterpret_cast<const UCKeyboardLayout*>(CFDataGetBytePtr(layoutData));
    for (CGKeyCode code = 0; code < 128; code += 1) {
      UInt32 deadKeyState = 0;
      UniChar chars[4] = {0};
      UniCharCount length = 0;
      OSStatus status =
          UCKeyTranslate(keyboardLayout, code, kUCKeyActionDisplay, 0, LMGetKbdType(),
                         kUCKeyTranslateNoDeadKeysBit, &deadKeyState, 4, &length, chars);
      if (status == noErr && length == 1 &&
          (chars[0] == wanted || chars[0] == wanted + ('A' - 'a'))) {
        resolved = code;
        break;
      }
    }
  }
  CFRelease(layout);
  return resolved;
}

}  // namespace

Napi::Value PostPaste(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  pid_t expectedPid = 0;
  if (!ArgsMatch(info, {ArgKind::Number}) || !ReadPid(info[0], &expectedPid)) {
    return Napi::Boolean::New(env, false);
  }
  CGKeyCode vKey = KeyCodeForChar('v', kKeyCodeV);
  return Napi::Boolean::New(
      env, PostKeyToFrontmost(expectedPid, vKey, kKeyCodeCommand, kCGEventFlagMaskCommand));
}

/**
 * Posts Return, optionally with a real modifier, for callers submitting what they inserted.
 * Chat-style applications disagree on the send chord (Enter, Shift-Enter, Cmd-Enter), so the
 * modifier is the caller's choice; unknown modifier strings refuse rather than guess.
 */
Napi::Value PostReturn(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  pid_t expectedPid = 0;
  if (!ArgsMatch(info, {ArgKind::Number, ArgKind::String}) || !ReadPid(info[0], &expectedPid)) {
    return Napi::Boolean::New(env, false);
  }
  std::string modifier = info[1].As<Napi::String>().Utf8Value();
  CGKeyCode modifierKey = kNoModifierKey;
  CGEventFlags flags = static_cast<CGEventFlags>(0);
  if (modifier == "shift") {
    modifierKey = kKeyCodeShift;
    flags = kCGEventFlagMaskShift;
  } else if (modifier == "command") {
    modifierKey = kKeyCodeCommand;
    flags = kCGEventFlagMaskCommand;
  } else if (modifier != "none") {
    return Napi::Boolean::New(env, false);
  }
  return Napi::Boolean::New(env,
                            PostKeyToFrontmost(expectedPid, kKeyCodeReturn, modifierKey, flags));
}

/** Deletes a live selection ahead of typing into editors that replace-on-keydown. */
Napi::Value PostBackspace(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  pid_t expectedPid = 0;
  if (!ArgsMatch(info, {ArgKind::Number}) || !ReadPid(info[0], &expectedPid)) {
    return Napi::Boolean::New(env, false);
  }
  return Napi::Boolean::New(env, PostKeyToFrontmost(expectedPid, kKeyCodeDelete, kNoModifierKey,
                                                    static_cast<CGEventFlags>(0)));
}

Napi::Value TypeUnicode(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  pid_t expectedPid = 0;
  if (!ArgsMatch(info, {ArgKind::Number, ArgKind::String}) || !ReadPid(info[0], &expectedPid)) {
    return RejectBadArgs(env, "typeUnicode(expectedPid, text)");
  }
  if (FocusedAppPid() != expectedPid) {
    auto deferred = Napi::Promise::Deferred::New(env);
    deferred.Resolve(Napi::Boolean::New(env, false));
    return deferred.Promise();
  }

  NSString* text = [NSString stringWithUTF8String:info[1].As<Napi::String>().Utf8Value().c_str()];
  NSUInteger length = text ? text.length : 0;
  if (length == 0 || length > kMaxTypeUnits) {
    auto deferred = Napi::Promise::Deferred::New(env);
    deferred.Resolve(Napi::Boolean::New(env, false));
    return deferred.Promise();
  }

  std::vector<UniChar> units(length);
  [text getCharacters:units.data() range:NSMakeRange(0, length)];
  auto* worker = new TypeUnicodeWorker(env, expectedPid, std::move(units));
  worker->Queue();
  return worker->Promise();
}

}  // namespace insertable
