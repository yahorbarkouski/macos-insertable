#import "accessibility_internal.h"

#include <vector>

namespace insertable {

const useconds_t kMirrorSettleUs[] = {10 * 1000, 35 * 1000, 35 * 1000};

std::string CFStringToStd(CFStringRef value) {
  if (!value) return "";
  CFIndex length = CFStringGetLength(value);
  if (length == 0) return "";
  CFIndex capacity = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
  std::vector<char> buffer(static_cast<size_t>(capacity));
  if (!CFStringGetCString(value, buffer.data(), capacity, kCFStringEncodingUTF8)) return "";
  return std::string(buffer.data());
}

CFStringRef CreateCFString(const std::string& value) {
  return CFStringCreateWithBytes(kCFAllocatorDefault, reinterpret_cast<const UInt8*>(value.data()),
                                 static_cast<CFIndex>(value.size()), kCFStringEncodingUTF8, false);
}

bool CopyAxString(AXUIElementRef element, CFStringRef attribute, std::string* out) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess) return false;
  if (!value) return false;
  bool ok = false;
  if (CFGetTypeID(value) == CFStringGetTypeID()) {
    *out = CFStringToStd(static_cast<CFStringRef>(value));
    ok = true;
  }
  CFRelease(value);
  return ok;
}

/** Reads a string attribute, truncating to `maxChars` UTF-16 units. */
bool CopyAxStringCapped(AXUIElementRef element, CFStringRef attribute, CFIndex maxChars,
                        std::string* out) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess) return false;
  if (!value) return false;
  bool ok = false;
  if (CFGetTypeID(value) == CFStringGetTypeID()) {
    CFStringRef text = static_cast<CFStringRef>(value);
    CFIndex length = CFStringGetLength(text);
    if (maxChars > 0 && length > maxChars) {
      CFStringRef head =
          CFStringCreateWithSubstring(kCFAllocatorDefault, text, CFRangeMake(0, maxChars));
      // A cut on a UTF-16 boundary can split a surrogate pair; the TypeScript side runs every
      // captured string through a well-formedness pass before it can be serialized.
      *out = CFStringToStd(head);
      if (head) CFRelease(head);
    } else {
      *out = CFStringToStd(text);
    }
    ok = true;
  }
  CFRelease(value);
  return ok;
}

bool CopyAxRange(AXUIElementRef element, CFStringRef attribute, CFRange* out) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess) return false;
  if (!value) return false;
  bool ok = false;
  if (CFGetTypeID(value) == AXValueGetTypeID() &&
      AXValueGetType(static_cast<AXValueRef>(value)) == kAXValueTypeCFRange) {
    ok = AXValueGetValue(static_cast<AXValueRef>(value), kAXValueTypeCFRange, out);
  }
  CFRelease(value);
  return ok;
}

bool CopyAxLong(AXUIElementRef element, CFStringRef attribute, long* out) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess) return false;
  if (!value) return false;
  bool ok = false;
  if (CFGetTypeID(value) == CFNumberGetTypeID()) {
    ok = CFNumberGetValue(static_cast<CFNumberRef>(value), kCFNumberLongType, out);
  }
  CFRelease(value);
  return ok;
}

bool CopyAxBool(AXUIElementRef element, CFStringRef attribute, bool fallback) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess) return fallback;
  if (!value) return fallback;
  bool result = fallback;
  if (CFGetTypeID(value) == CFBooleanGetTypeID()) {
    result = CFBooleanGetValue(static_cast<CFBooleanRef>(value));
  }
  CFRelease(value);
  return result;
}

bool CopyAxPoint(AXUIElementRef element, CFStringRef attribute, CGPoint* out) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess) return false;
  if (!value) return false;
  bool ok = false;
  if (CFGetTypeID(value) == AXValueGetTypeID() &&
      AXValueGetType(static_cast<AXValueRef>(value)) == kAXValueTypeCGPoint) {
    ok = AXValueGetValue(static_cast<AXValueRef>(value), kAXValueTypeCGPoint, out);
  }
  CFRelease(value);
  return ok;
}

bool CopyAxSize(AXUIElementRef element, CFStringRef attribute, CGSize* out) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess) return false;
  if (!value) return false;
  bool ok = false;
  if (CFGetTypeID(value) == AXValueGetTypeID() &&
      AXValueGetType(static_cast<AXValueRef>(value)) == kAXValueTypeCGSize) {
    ok = AXValueGetValue(static_cast<AXValueRef>(value), kAXValueTypeCGSize, out);
  }
  CFRelease(value);
  return ok;
}

/** Whether `frame` intersects any active display, in CG global (top-left origin) coordinates —
 *  the space kAXPositionAttribute reports in. A raw fact for TypeScript's decoy judgment. */
bool FrameIntersectsAnyDisplay(CGRect frame) {
  CGDirectDisplayID displays[16];
  uint32_t count = 0;
  if (CGGetActiveDisplayList(16, displays, &count) != kCGErrorSuccess) return true;
  for (uint32_t i = 0; i < count; i += 1) {
    if (CGRectIntersectsRect(CGDisplayBounds(displays[i]), frame)) return true;
  }
  return count == 0;
}

bool IsAttributeSettable(AXUIElementRef element, CFStringRef attribute) {
  Boolean settable = false;
  if (AXUIElementIsAttributeSettable(element, attribute, &settable) != kAXErrorSuccess)
    return false;
  return settable ? true : false;
}

/**
 * Every attribute the element advertises. This is what lets text capability be *detected* rather
 * than guessed from a list of known roles: an element that carries AXValue and AXSelectedTextRange
 * behaves like a text box no matter what an application chose to call it.
 */
std::vector<std::string> CopyAttributeNames(AXUIElementRef element) {
  std::vector<std::string> names;
  CFArrayRef attributes = NULL;
  if (AXUIElementCopyAttributeNames(element, &attributes) != kAXErrorSuccess) return names;
  if (!attributes) return names;
  CFIndex count = CFArrayGetCount(attributes);
  names.reserve(static_cast<size_t>(count));
  for (CFIndex i = 0; i < count; i += 1) {
    CFTypeRef entry = CFArrayGetValueAtIndex(attributes, i);
    if (entry && CFGetTypeID(entry) == CFStringGetTypeID()) {
      names.push_back(CFStringToStd(static_cast<CFStringRef>(entry)));
    }
  }
  CFRelease(attributes);
  return names;
}

void ReadTextState(AXUIElementRef element, CFIndex valueMaxChars, TextState* state) {
  state->hasValue = CopyAxStringCapped(element, kAXValueAttribute, valueMaxChars, &state->value);
  CopyAxString(element, kAXSelectedTextAttribute, &state->selectedText);
  CFRange range = CFRangeMake(0, 0);
  if (CopyAxRange(element, kAXSelectedTextRangeAttribute, &range)) {
    state->hasSelection = true;
    state->selectionStart = static_cast<long>(range.location);
    state->selectionLength = static_cast<long>(range.length);
  }
  CopyAxLong(element, kAXNumberOfCharactersAttribute, &state->numberOfCharacters);
}

Napi::Object TextStateToObject(Napi::Env env, const TextState& state) {
  Napi::Object object = Napi::Object::New(env);
  object.Set("hasValue", Napi::Boolean::New(env, state.hasValue));
  object.Set("value", Napi::String::New(env, state.value));
  object.Set("selectedText", Napi::String::New(env, state.selectedText));
  if (state.hasSelection) {
    object.Set("selectionStart", Napi::Number::New(env, static_cast<double>(state.selectionStart)));
    object.Set("selectionLength",
               Napi::Number::New(env, static_cast<double>(state.selectionLength)));
  } else {
    object.Set("selectionStart", env.Null());
    object.Set("selectionLength", env.Null());
  }
  object.Set("numberOfCharacters",
             Napi::Number::New(env, static_cast<double>(state.numberOfCharacters)));
  return object;
}

void ReadIdentity(AXUIElementRef element, ElementIdentity* identity) {
  CopyAxString(element, kAXRoleAttribute, &identity->role);
  CopyAxString(element, kAXSubroleAttribute, &identity->subrole);
  CopyAxString(element, kAXTitleAttribute, &identity->title);
  CopyAxString(element, kAXDescriptionAttribute, &identity->description);
  CopyAxString(element, CFSTR("AXPlaceholderValue"), &identity->placeholder);
  CopyAxString(element, CFSTR("AXIdentifier"), &identity->identifier);
}

void AssignIdentity(Napi::Object object, const ElementIdentity& identity) {
  Napi::Env env = object.Env();
  object.Set("role", Napi::String::New(env, identity.role));
  object.Set("subrole", Napi::String::New(env, identity.subrole));
  object.Set("title", Napi::String::New(env, identity.title));
  object.Set("description", Napi::String::New(env, identity.description));
  object.Set("placeholder", Napi::String::New(env, identity.placeholder));
  object.Set("identifier", Napi::String::New(env, identity.identifier));
}

/** Applies the messaging timeout that keeps a wedged target app from blocking a libuv worker. */
void ApplyTimeout(AXUIElementRef element, double timeoutMs) {
  AXUIElementSetMessagingTimeout(element, static_cast<float>(timeoutMs / 1000.0));
}

AXUIElementRef CopyFocusedElement(pid_t pid, double timeoutMs) {
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  if (!app) return NULL;
  ApplyTimeout(app, timeoutMs);
  CFTypeRef focused = NULL;
  AXError error = AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute, &focused);
  CFRelease(app);
  if (error != kAXErrorSuccess || !focused) return NULL;
  if (CFGetTypeID(focused) != AXUIElementGetTypeID()) {
    CFRelease(focused);
    return NULL;
  }
  AXUIElementRef element = static_cast<AXUIElementRef>(focused);
  ApplyTimeout(element, timeoutMs);
  return element;
}

}  // namespace insertable
