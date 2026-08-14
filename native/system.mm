#import "system.h"
#import "napi_support.h"

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#import <CoreGraphics/CoreGraphics.h>
#import <IOKit/IOKitLib.h>

namespace insertable {

/**
 * Returns the owner of the frontmost ordinary window from a fresh WindowServer query. The
 * notification-fed NSWorkspace and system-wide AX focus values can freeze when Node does not
 * service an NSRunLoop.
 */
pid_t FocusedAppPid() {
  CFArrayRef windows = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
  if (!windows) return -1;
  pid_t pid = -1;
  CFIndex count = CFArrayGetCount(windows);
  for (CFIndex i = 0; i < count && pid < 0; i += 1) {
    CFDictionaryRef window = static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(windows, i));
    if (!window) continue;
    CFNumberRef layerRef = static_cast<CFNumberRef>(CFDictionaryGetValue(window, kCGWindowLayer));
    int layer = -1;
    if (!layerRef || !CFNumberGetValue(layerRef, kCFNumberIntType, &layer) || layer != 0) {
      continue;
    }
    CFNumberRef ownerRef =
        static_cast<CFNumberRef>(CFDictionaryGetValue(window, kCGWindowOwnerPID));
    int owner = -1;
    if (ownerRef && CFNumberGetValue(ownerRef, kCFNumberIntType, &owner)) {
      pid = static_cast<pid_t>(owner);
    }
  }
  CFRelease(windows);
  return pid;
}

Napi::Value IsAccessibilityTrusted(const Napi::CallbackInfo& info) {
  // The options variant, not AXIsProcessTrusted(): the plain call caches its first answer for
  // the process lifetime, so a grant revoked mid-run keeps reading as trusted forever.
  return Napi::Boolean::New(info.Env(), AXIsProcessTrustedWithOptions(NULL) ? true : false);
}

/**
 * Names the process holding the Secure Event Input grab, or null. The pid lives in the
 * IOConsoleUsers property on the IORegistry ROOT entry — not under IOResources, as most
 * write-ups claim. Best effort by Apple's own design: no reliable API is documented, and the
 * pid can be wrong or absent when the grab was taken while the app was backgrounded.
 */
Napi::Value SecureInputCulprit(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!IsSecureEventInputEnabled()) return env.Null();

  // kIOMainPortDefault is macOS 12+; the deployment target is 11. Both spellings are the same
  // NULL-equivalent default port, so passing 0 works on every supported version without an
  // availability guard around the call.
  io_registry_entry_t root = IORegistryGetRootEntry(MACH_PORT_NULL);
  if (!root) return env.Null();
  CFTypeRef users =
      IORegistryEntryCreateCFProperty(root, CFSTR("IOConsoleUsers"), kCFAllocatorDefault, 0);
  IOObjectRelease(root);
  if (!users) return env.Null();

  pid_t culpritPid = -1;
  if (CFGetTypeID(users) == CFArrayGetTypeID()) {
    CFArrayRef array = static_cast<CFArrayRef>(users);
    for (CFIndex i = 0; i < CFArrayGetCount(array) && culpritPid < 0; i += 1) {
      CFTypeRef entry = CFArrayGetValueAtIndex(array, i);
      if (!entry || CFGetTypeID(entry) != CFDictionaryGetTypeID()) continue;
      CFTypeRef pidRef = CFDictionaryGetValue(static_cast<CFDictionaryRef>(entry),
                                              CFSTR("kCGSSessionSecureInputPID"));
      if (pidRef && CFGetTypeID(pidRef) == CFNumberGetTypeID()) {
        int value = -1;
        if (CFNumberGetValue(static_cast<CFNumberRef>(pidRef), kCFNumberIntType, &value)) {
          culpritPid = static_cast<pid_t>(value);
        }
      }
    }
  }
  CFRelease(users);
  if (culpritPid <= 0) return env.Null();

  Napi::Object result = Napi::Object::New(env);
  result.Set("pid", Napi::Number::New(env, static_cast<double>(culpritPid)));
  NSRunningApplication* app =
      [NSRunningApplication runningApplicationWithProcessIdentifier:culpritPid];
  const char* name = app && app.localizedName ? app.localizedName.UTF8String : NULL;
  const char* bundleId = app && app.bundleIdentifier ? app.bundleIdentifier.UTF8String : NULL;
  result.Set("name", Napi::String::New(env, name ? name : ""));
  result.Set("bundleId", Napi::String::New(env, bundleId ? bundleId : ""));
  return result;
}

/** The modifier flags the user is physically holding right now, masked to the four that turn a
 *  keystroke into a shortcut. */
Napi::Value CurrentModifierFlags(const Napi::CallbackInfo& info) {
  CGEventFlags flags = CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState);
  constexpr CGEventFlags interesting = kCGEventFlagMaskCommand | kCGEventFlagMaskShift |
                                       kCGEventFlagMaskControl | kCGEventFlagMaskAlternate;
  return Napi::Number::New(info.Env(), static_cast<double>(flags & interesting));
}

/**
 * Secure Event Input is on whenever any app has a password field up. It suppresses synthetic
 * events system-wide, so delivery attempted under it can silently go nowhere.
 */
Napi::Value IsSecureInputEnabled(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), IsSecureEventInputEnabled() ? true : false);
}

Napi::Value FrontmostApp(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  pid_t focusedPid = FocusedAppPid();
  // By-pid lookup is a fresh query, unlike the notification-fed frontmostApplication. The
  // NSWorkspace value remains the fallback when accessibility is not granted.
  NSRunningApplication* app =
      focusedPid > 0 ? [NSRunningApplication runningApplicationWithProcessIdentifier:focusedPid]
                     : [[NSWorkspace sharedWorkspace] frontmostApplication];
  if (!app) return env.Null();
  Napi::Object result = Napi::Object::New(env);
  result.Set("pid", Napi::Number::New(env, static_cast<double>(app.processIdentifier)));
  const char* bundleId = app.bundleIdentifier ? app.bundleIdentifier.UTF8String : NULL;
  const char* name = app.localizedName ? app.localizedName.UTF8String : NULL;
  result.Set("bundleId", Napi::String::New(env, bundleId ? bundleId : ""));
  result.Set("name", Napi::String::New(env, name ? name : ""));
  return result;
}

}  // namespace insertable
