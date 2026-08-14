#import "accessibility.h"
#import "accessibility_internal.h"
#import "addon_state.h"
#import "napi_support.h"

#include <utility>

namespace insertable {

namespace {

class ReadFocusedWorker : public PromiseWorker {
 public:
  ReadFocusedWorker(Napi::Env env, AddonStateHandle state, pid_t pid, double timeoutMs,
                    CFIndex valueMaxChars)
      : PromiseWorker(env),
        addonState_(std::move(state)),
        pid_(pid),
        timeoutMs_(timeoutMs),
        valueMaxChars_(valueMaxChars) {}

  void Execute() override {
    AXUIElementRef element = CopyFocusedElement(pid_, timeoutMs_);
    if (!element) return;

    ReadIdentity(element, &identity_);
    // A password field's text must not reach the JS heap at all. macOS normally withholds it from
    // AXValue, but the classification is cheap here and this is the earliest point it can hold —
    // TypeScript rejecting the element later is a second line, not the first.
    if (identity_.subrole != "AXSecureTextField") {
      ReadTextState(element, valueMaxChars_, &state_);
    }
    attributeNames_ = CopyAttributeNames(element);
    valueSettable_ = IsAttributeSettable(element, kAXValueAttribute);
    selectedTextSettable_ = IsAttributeSettable(element, kAXSelectedTextAttribute);
    enabled_ = CopyAxBool(element, kAXEnabledAttribute, true);
    CGPoint origin = CGPointZero;
    CGSize size = CGSizeZero;
    if (CopyAxPoint(element, kAXPositionAttribute, &origin) &&
        CopyAxSize(element, kAXSizeAttribute, &size)) {
      hasFrame_ = true;
      frame_ = CGRectMake(origin.x, origin.y, size.width, size.height);
      frameOnScreen_ = FrameIntersectsAnyDisplay(frame_);
    }
    token_ = addonState_->elements.Store(element);
    found_ = true;
    CFRelease(element);
  }

  void OnOK() override {
    Napi::Env env = Env();
    if (!found_) {
      deferred_.Resolve(env.Null());
      return;
    }
    Napi::Object result = TextStateToObject(env, state_);
    AssignIdentity(result, identity_);
    result.Set("token", Napi::String::New(env, token_));
    result.Set("valueSettable", Napi::Boolean::New(env, valueSettable_));
    result.Set("selectedTextSettable", Napi::Boolean::New(env, selectedTextSettable_));
    result.Set("enabled", Napi::Boolean::New(env, enabled_));
    if (hasFrame_) {
      Napi::Object frame = Napi::Object::New(env);
      frame.Set("x", Napi::Number::New(env, frame_.origin.x));
      frame.Set("y", Napi::Number::New(env, frame_.origin.y));
      frame.Set("width", Napi::Number::New(env, frame_.size.width));
      frame.Set("height", Napi::Number::New(env, frame_.size.height));
      result.Set("frame", frame);
      result.Set("frameOnScreen", Napi::Boolean::New(env, frameOnScreen_));
    } else {
      result.Set("frame", env.Null());
      result.Set("frameOnScreen", Napi::Boolean::New(env, true));
    }
    Napi::Array attributes = Napi::Array::New(env, attributeNames_.size());
    for (size_t i = 0; i < attributeNames_.size(); i += 1) {
      attributes.Set(i, Napi::String::New(env, attributeNames_[i]));
    }
    result.Set("attributeNames", attributes);
    deferred_.Resolve(result);
  }

 private:
  AddonStateHandle addonState_;
  pid_t pid_;
  double timeoutMs_;
  CFIndex valueMaxChars_;
  bool found_ = false;
  std::string token_;
  ElementIdentity identity_;
  TextState state_;
  std::vector<std::string> attributeNames_;
  bool valueSettable_ = false;
  bool selectedTextSettable_ = false;
  bool enabled_ = true;
  bool hasFrame_ = false;
  CGRect frame_ = CGRectZero;
  bool frameOnScreen_ = true;
};

/**
 * Re-reads the identity of the app's currently focused element and reports whether it is the very
 * same element object captured earlier (CFEqual on the AXUIElementRef, which is stronger than any
 * attribute comparison). TypeScript still compares the identity string on top of this.
 */
class VerifyWorker : public PromiseWorker {
 public:
  VerifyWorker(Napi::Env env, AddonStateHandle state, std::string token, pid_t pid,
               double timeoutMs)
      : PromiseWorker(env),
        addonState_(std::move(state)),
        token_(std::move(token)),
        pid_(pid),
        timeoutMs_(timeoutMs) {}

  void Execute() override {
    AXUIElementRef captured = addonState_->elements.Copy(token_);
    if (!captured) return;
    AXUIElementRef focused = CopyFocusedElement(pid_, timeoutMs_);
    if (!focused) {
      CFRelease(captured);
      return;
    }
    sameElement_ = CFEqual(captured, focused) ? true : false;
    ReadIdentity(focused, &identity_);
    enabled_ = CopyAxBool(focused, kAXEnabledAttribute, true);
    found_ = true;
    CFRelease(focused);
    CFRelease(captured);
  }

  void OnOK() override {
    Napi::Env env = Env();
    if (!found_) {
      deferred_.Resolve(env.Null());
      return;
    }
    Napi::Object result = Napi::Object::New(env);
    AssignIdentity(result, identity_);
    result.Set("sameElement", Napi::Boolean::New(env, sameElement_));
    result.Set("enabled", Napi::Boolean::New(env, enabled_));
    deferred_.Resolve(result);
  }

 private:
  AddonStateHandle addonState_;
  std::string token_;
  pid_t pid_;
  double timeoutMs_;
  bool found_ = false;
  bool sameElement_ = false;
  bool enabled_ = true;
  ElementIdentity identity_;
};

/** Asks Chromium-backed applications to build their accessibility tree. Diagnostic only. */
class PrimeAccessibilityWorker : public PromiseWorker {
 public:
  PrimeAccessibilityWorker(Napi::Env env, pid_t pid, double timeoutMs)
      : PromiseWorker(env), pid_(pid), timeoutMs_(timeoutMs) {}

  void Execute() override {
    AXUIElementRef app = AXUIElementCreateApplication(pid_);
    if (!app) return;
    ApplyTimeout(app, timeoutMs_);
    ok_ = AXUIElementSetAttributeValue(app, CFSTR("AXManualAccessibility"), kCFBooleanTrue) ==
          kAXErrorSuccess;
    CFRelease(app);
  }

  void OnOK() override { deferred_.Resolve(Napi::Boolean::New(Env(), ok_)); }

 private:
  pid_t pid_;
  double timeoutMs_;
  bool ok_ = false;
};

/** Reads an element's current text state without writing — used to verify a paste landed. */
class ReadStateWorker : public PromiseWorker {
 public:
  ReadStateWorker(Napi::Env env, AddonStateHandle state, std::string token, double timeoutMs,
                  CFIndex valueMaxChars)
      : PromiseWorker(env),
        addonState_(std::move(state)),
        token_(std::move(token)),
        timeoutMs_(timeoutMs),
        valueMaxChars_(valueMaxChars) {}

  void Execute() override {
    AXUIElementRef element = addonState_->elements.Copy(token_);
    if (!element) return;
    ApplyTimeout(element, timeoutMs_);
    ReadTextState(element, valueMaxChars_, &state_);
    found_ = true;
    CFRelease(element);
  }

  void OnOK() override {
    Napi::Env env = Env();
    deferred_.Resolve(found_ ? TextStateToObject(env, state_).As<Napi::Value>() : env.Null());
  }

 private:
  AddonStateHandle addonState_;
  std::string token_;
  double timeoutMs_;
  CFIndex valueMaxChars_;
  bool found_ = false;
  TextState state_;
};

/**
 * The on-screen rectangle of a text range — a zero-length range at the caret returns the caret's
 * own rectangle. Lets a caller anchor UI (a HUD, ghost text, a correction popover) to the exact
 * insertion point. `AXBoundsForRange` answers in global screen coordinates on AppKit and web
 * content alike; when the element exposes no range at the caret, the last glyph's trailing edge
 * keeps real line height where an empty-caret rectangle would collapse to nothing.
 */
class CaretBoundsWorker : public PromiseWorker {
 public:
  CaretBoundsWorker(Napi::Env env, AddonStateHandle state, std::string token, double timeoutMs)
      : PromiseWorker(env),
        addonState_(std::move(state)),
        token_(std::move(token)),
        timeoutMs_(timeoutMs) {}

  void Execute() override {
    AXUIElementRef element = addonState_->elements.Copy(token_);
    if (!element) return;
    ApplyTimeout(element, timeoutMs_);

    CFRange selection = CFRangeMake(0, 0);
    bool haveSelection = CopyAxRange(element, kAXSelectedTextRangeAttribute, &selection);
    long caret = haveSelection ? selection.location : 0;

    if (BoundsForRange(element, CFRangeMake(caret, 0), &rect_)) {
      found_ = true;
    } else if (caret > 0 && BoundsForRange(element, CFRangeMake(caret - 1, 1), &rect_)) {
      // A collapsed caret range was refused; the previous glyph's box carries the line height.
      rect_.origin.x += rect_.size.width;
      rect_.size.width = 0;
      found_ = true;
    }
    CFRelease(element);
  }

  void OnOK() override {
    Napi::Env env = Env();
    if (!found_) {
      deferred_.Resolve(env.Null());
      return;
    }
    Napi::Object result = Napi::Object::New(env);
    result.Set("x", Napi::Number::New(env, rect_.origin.x));
    result.Set("y", Napi::Number::New(env, rect_.origin.y));
    result.Set("width", Napi::Number::New(env, rect_.size.width));
    result.Set("height", Napi::Number::New(env, rect_.size.height));
    deferred_.Resolve(result);
  }

 private:
  static bool BoundsForRange(AXUIElementRef element, CFRange range, CGRect* out) {
    AXValueRef rangeValue = AXValueCreate(kAXValueTypeCFRange, &range);
    if (!rangeValue) return false;
    CFTypeRef result = NULL;
    AXError error = AXUIElementCopyParameterizedAttributeValue(
        element, kAXBoundsForRangeParameterizedAttribute, rangeValue, &result);
    CFRelease(rangeValue);
    if (error != kAXErrorSuccess || !result) return false;
    bool ok = CFGetTypeID(result) == AXValueGetTypeID() &&
              AXValueGetType(static_cast<AXValueRef>(result)) == kAXValueTypeCGRect &&
              AXValueGetValue(static_cast<AXValueRef>(result), kAXValueTypeCGRect, out);
    CFRelease(result);
    return ok;
  }

  AddonStateHandle addonState_;
  std::string token_;
  double timeoutMs_;
  bool found_ = false;
  CGRect rect_ = CGRectZero;
};

/** Performs the element's AXConfirm action when the element advertises it. */
class ConfirmWorker : public PromiseWorker {
 public:
  ConfirmWorker(Napi::Env env, AddonStateHandle state, std::string token, double timeoutMs)
      : PromiseWorker(env),
        addonState_(std::move(state)),
        token_(std::move(token)),
        timeoutMs_(timeoutMs) {}

  void Execute() override {
    AXUIElementRef element = addonState_->elements.Copy(token_);
    if (!element) return;
    ApplyTimeout(element, timeoutMs_);

    CFArrayRef actions = NULL;
    if (AXUIElementCopyActionNames(element, &actions) == kAXErrorSuccess && actions) {
      CFIndex count = CFArrayGetCount(actions);
      for (CFIndex i = 0; i < count && !advertised_; i += 1) {
        CFTypeRef entry = CFArrayGetValueAtIndex(actions, i);
        if (entry && CFGetTypeID(entry) == CFStringGetTypeID() &&
            CFStringCompare(static_cast<CFStringRef>(entry), kAXConfirmAction, 0) ==
                kCFCompareEqualTo) {
          advertised_ = true;
        }
      }
      CFRelease(actions);
    }
    if (advertised_) {
      ok_ = AXUIElementPerformAction(element, kAXConfirmAction) == kAXErrorSuccess;
    }
    CFRelease(element);
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Object result = Napi::Object::New(env);
    result.Set("ok", Napi::Boolean::New(env, ok_));
    result.Set("advertised", Napi::Boolean::New(env, advertised_));
    deferred_.Resolve(result);
  }

 private:
  AddonStateHandle addonState_;
  std::string token_;
  double timeoutMs_;
  bool advertised_ = false;
  bool ok_ = false;
};

}  // namespace

Napi::Value ReadFocusedElement(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  pid_t pid = 0;
  double timeoutMs = 0;
  CFIndex valueMaxChars = 0;
  if (!ArgsMatch(info, {ArgKind::Number, ArgKind::Number, ArgKind::Number}) ||
      !ReadPid(info[0], &pid) || !ReadTimeout(info[1], &timeoutMs) ||
      !ReadIndex(info[2], &valueMaxChars)) {
    return RejectBadArgs(env, "readFocusedElement(pid, timeoutMs, valueMaxChars)");
  }
  auto* worker = new ReadFocusedWorker(env, StateFrom(info), pid, timeoutMs, valueMaxChars);
  worker->Queue();
  return worker->Promise();
}

Napi::Value VerifyElement(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  pid_t pid = 0;
  double timeoutMs = 0;
  if (!ArgsMatch(info, {ArgKind::String, ArgKind::Number, ArgKind::Number}) ||
      !ReadPid(info[1], &pid) || !ReadTimeout(info[2], &timeoutMs)) {
    return RejectBadArgs(env, "verifyElement(token, pid, timeoutMs)");
  }
  std::string token = info[0].As<Napi::String>().Utf8Value();
  auto* worker = new VerifyWorker(env, StateFrom(info), std::move(token), pid, timeoutMs);
  worker->Queue();
  return worker->Promise();
}

Napi::Value CaretBounds(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  double timeoutMs = 0;
  if (!ArgsMatch(info, {ArgKind::String, ArgKind::Number}) || !ReadTimeout(info[1], &timeoutMs)) {
    return RejectBadArgs(env, "caretBounds(token, timeoutMs)");
  }
  auto* worker = new CaretBoundsWorker(env, StateFrom(info), info[0].As<Napi::String>().Utf8Value(),
                                       timeoutMs);
  worker->Queue();
  return worker->Promise();
}

Napi::Value ConfirmElement(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  double timeoutMs = 0;
  if (!ArgsMatch(info, {ArgKind::String, ArgKind::Number}) || !ReadTimeout(info[1], &timeoutMs)) {
    return RejectBadArgs(env, "confirmElement(token, timeoutMs)");
  }
  auto* worker =
      new ConfirmWorker(env, StateFrom(info), info[0].As<Napi::String>().Utf8Value(), timeoutMs);
  worker->Queue();
  return worker->Promise();
}

Napi::Value PrimeAccessibility(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  pid_t pid = 0;
  double timeoutMs = 0;
  if (!ArgsMatch(info, {ArgKind::Number, ArgKind::Number}) || !ReadPid(info[0], &pid) ||
      !ReadTimeout(info[1], &timeoutMs)) {
    return RejectBadArgs(env, "primeAccessibility(pid, timeoutMs)");
  }
  auto* worker = new PrimeAccessibilityWorker(env, pid, timeoutMs);
  worker->Queue();
  return worker->Promise();
}

Napi::Value ReadElementState(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  double timeoutMs = 0;
  CFIndex valueMaxChars = 0;
  if (!ArgsMatch(info, {ArgKind::String, ArgKind::Number, ArgKind::Number}) ||
      !ReadTimeout(info[1], &timeoutMs) || !ReadIndex(info[2], &valueMaxChars)) {
    return RejectBadArgs(env, "readElementState(token, timeoutMs, valueMaxChars)");
  }
  auto* worker = new ReadStateWorker(env, StateFrom(info), info[0].As<Napi::String>().Utf8Value(),
                                     timeoutMs, valueMaxChars);
  worker->Queue();
  return worker->Promise();
}

Napi::Value ReleaseElement(const Napi::CallbackInfo& info) {
  if (!ArgsMatch(info, {ArgKind::String})) return info.Env().Undefined();
  StateFrom(info)->elements.Release(info[0].As<Napi::String>().Utf8Value());
  return info.Env().Undefined();
}

}  // namespace insertable
