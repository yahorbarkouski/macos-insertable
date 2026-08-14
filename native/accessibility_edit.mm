#import "accessibility.h"
#import "accessibility_internal.h"
#import "addon_state.h"
#import "napi_support.h"

#include <utility>

namespace insertable {

namespace {

/** Sets one text attribute and reads the element back in the same worker trip. */
class SetTextWorker : public PromiseWorker {
 public:
  SetTextWorker(Napi::Env env, AddonStateHandle state, std::string token, CFStringRef attribute,
                std::string text, double timeoutMs, CFIndex valueMaxChars)
      : PromiseWorker(env),
        addonState_(std::move(state)),
        token_(std::move(token)),
        attribute_(attribute),
        text_(std::move(text)),
        timeoutMs_(timeoutMs),
        valueMaxChars_(valueMaxChars) {}

  void Execute() override {
    AXUIElementRef element = addonState_->elements.Copy(token_);
    if (!element) {
      error_ = "unknown-token";
      return;
    }
    ApplyTimeout(element, timeoutMs_);
    CFStringRef value = CreateCFString(text_);
    if (!value) {
      CFRelease(element);
      error_ = "encoding-failed";
      return;
    }
    AXError result = AXUIElementSetAttributeValue(element, attribute_, value);
    CFRelease(value);
    ok_ = result == kAXErrorSuccess;
    if (!ok_) error_ = "ax-error-" + std::to_string(static_cast<int>(result));
    ReadTextState(element, valueMaxChars_, &after_);
    hasAfter_ = true;
    CFRelease(element);
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Object result = Napi::Object::New(env);
    result.Set("ok", Napi::Boolean::New(env, ok_));
    result.Set("error",
               error_.empty() ? env.Null() : Napi::String::New(env, error_).As<Napi::Value>());
    result.Set("after", hasAfter_ ? TextStateToObject(env, after_).As<Napi::Value>() : env.Null());
    deferred_.Resolve(result);
  }

 private:
  AddonStateHandle addonState_;
  std::string token_;
  CFStringRef attribute_;
  std::string text_;
  double timeoutMs_;
  CFIndex valueMaxChars_;
  bool ok_ = false;
  bool hasAfter_ = false;
  std::string error_;
  TextState after_;
};

/** Sets and reads back the selected UTF-16 range on the Chromium mirror-settle schedule. */
class SetSelectionRangeWorker : public PromiseWorker {
 public:
  SetSelectionRangeWorker(Napi::Env env, AddonStateHandle state, std::string token, CFIndex start,
                          CFIndex length, double timeoutMs)
      : PromiseWorker(env),
        addonState_(std::move(state)),
        token_(std::move(token)),
        start_(start),
        length_(length),
        timeoutMs_(timeoutMs) {}

  void Execute() override {
    AXUIElementRef element = addonState_->elements.Copy(token_);
    if (!element) {
      error_ = "unknown-token";
      return;
    }
    ApplyTimeout(element, timeoutMs_);
    CFRange range = CFRangeMake(start_, length_);
    AXValueRef value = AXValueCreate(kAXValueTypeCFRange, &range);
    if (!value) {
      CFRelease(element);
      error_ = "encoding-failed";
      return;
    }
    AXError result = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute, value);
    CFRelease(value);
    ok_ = result == kAXErrorSuccess;
    if (!ok_) error_ = "ax-error-" + std::to_string(static_cast<int>(result));
    // Read back on the mirror-settle schedule: Chromium reports the OLD selection in the same
    // trip; without the settle every placement looks failed there.
    CFRange after = CFRangeMake(0, 0);
    for (int attempt = 0; attempt <= kMirrorSettleSteps; attempt += 1) {
      if (attempt > 0) usleep(kMirrorSettleUs[attempt - 1]);
      hasAfter_ = CopyAxRange(element, kAXSelectedTextRangeAttribute, &after);
      if (hasAfter_ && after.location == static_cast<CFIndex>(start_) &&
          after.length == static_cast<CFIndex>(length_)) {
        break;
      }
      if (!ok_) break;
    }
    afterStart_ = static_cast<long>(after.location);
    afterLength_ = static_cast<long>(after.length);
    CFRelease(element);
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Object result = Napi::Object::New(env);
    result.Set("ok", Napi::Boolean::New(env, ok_));
    result.Set("error",
               error_.empty() ? env.Null() : Napi::String::New(env, error_).As<Napi::Value>());
    if (hasAfter_) {
      result.Set("selectionStart", Napi::Number::New(env, static_cast<double>(afterStart_)));
      result.Set("selectionLength", Napi::Number::New(env, static_cast<double>(afterLength_)));
    } else {
      result.Set("selectionStart", env.Null());
      result.Set("selectionLength", env.Null());
    }
    deferred_.Resolve(result);
  }

 private:
  AddonStateHandle addonState_;
  std::string token_;
  CFIndex start_;
  CFIndex length_;
  double timeoutMs_;
  bool ok_ = false;
  bool hasAfter_ = false;
  long afterStart_ = 0;
  long afterLength_ = 0;
  std::string error_;
};

/** Invokes the parameterized AXReplaceRangeWithText operation and reports its raw answer. */
class ReplaceRangeWorker : public PromiseWorker {
 public:
  ReplaceRangeWorker(Napi::Env env, AddonStateHandle state, std::string token, CFIndex start,
                     CFIndex length, std::u16string text, double timeoutMs)
      : PromiseWorker(env),
        addonState_(std::move(state)),
        token_(std::move(token)),
        start_(start),
        length_(length),
        text_(std::move(text)),
        timeoutMs_(timeoutMs) {}

  void Execute() override {
    AXUIElementRef element = addonState_->elements.Copy(token_);
    if (!element) {
      error_ = "element-gone";
      return;
    }
    ApplyTimeout(element, timeoutMs_);

    CFRange range = CFRangeMake(start_, length_);
    AXValueRef rangeValue = AXValueCreate(kAXValueTypeCFRange, &range);
    CFStringRef replacement = CFStringCreateWithCharacters(
        kCFAllocatorDefault, reinterpret_cast<const UniChar*>(text_.data()),
        static_cast<CFIndex>(text_.size()));
    if (!rangeValue || !replacement) {
      if (rangeValue) CFRelease(rangeValue);
      if (replacement) CFRelease(replacement);
      CFRelease(element);
      error_ = "encoding-failed";
      return;
    }

    CFTypeRef keys[] = {CFSTR("AXReplacementRange"), CFSTR("AXReplacementText")};
    CFTypeRef values[] = {rangeValue, replacement};
    CFDictionaryRef params =
        CFDictionaryCreate(kCFAllocatorDefault, keys, values, 2, &kCFTypeDictionaryKeyCallBacks,
                           &kCFTypeDictionaryValueCallBacks);
    CFTypeRef result = NULL;
    AXError error = AXUIElementCopyParameterizedAttributeValue(
        element, CFSTR("AXReplaceRangeWithText"), params, &result);
    CFRelease(params);
    CFRelease(rangeValue);
    CFRelease(replacement);

    if (error == kAXErrorSuccess && result) {
      ok_ = CFGetTypeID(result) == CFBooleanGetTypeID() &&
            CFBooleanGetValue(static_cast<CFBooleanRef>(result));
    }
    if (result) CFRelease(result);
    if (!ok_) error_ = "unsupported";
    CFRelease(element);
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Object result = Napi::Object::New(env);
    result.Set("ok", Napi::Boolean::New(env, ok_));
    result.Set("error",
               error_.empty() ? env.Null() : Napi::String::New(env, error_).As<Napi::Value>());
    deferred_.Resolve(result);
  }

 private:
  AddonStateHandle addonState_;
  std::string token_;
  CFIndex start_;
  CFIndex length_;
  std::u16string text_;
  double timeoutMs_;
  bool ok_ = false;
  std::string error_;
};

}  // namespace

Napi::Value SetSelectedText(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  double timeoutMs = 0;
  CFIndex valueMaxChars = 0;
  if (!ArgsMatch(info, {ArgKind::String, ArgKind::String, ArgKind::Number, ArgKind::Number}) ||
      !ReadTimeout(info[2], &timeoutMs) || !ReadIndex(info[3], &valueMaxChars)) {
    return RejectBadArgs(env, "setSelectedText(token, text, timeoutMs, valueMaxChars)");
  }
  auto* worker = new SetTextWorker(env, StateFrom(info), info[0].As<Napi::String>().Utf8Value(),
                                   kAXSelectedTextAttribute, info[1].As<Napi::String>().Utf8Value(),
                                   timeoutMs, valueMaxChars);
  worker->Queue();
  return worker->Promise();
}

Napi::Value SetValue(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  double timeoutMs = 0;
  CFIndex valueMaxChars = 0;
  if (!ArgsMatch(info, {ArgKind::String, ArgKind::String, ArgKind::Number, ArgKind::Number}) ||
      !ReadTimeout(info[2], &timeoutMs) || !ReadIndex(info[3], &valueMaxChars)) {
    return RejectBadArgs(env, "setValue(token, text, timeoutMs, valueMaxChars)");
  }
  auto* worker = new SetTextWorker(env, StateFrom(info), info[0].As<Napi::String>().Utf8Value(),
                                   kAXValueAttribute, info[1].As<Napi::String>().Utf8Value(),
                                   timeoutMs, valueMaxChars);
  worker->Queue();
  return worker->Promise();
}

Napi::Value SetSelectedTextRange(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  CFIndex start = 0;
  CFIndex length = 0;
  double timeoutMs = 0;
  if (!ArgsMatch(info, {ArgKind::String, ArgKind::Number, ArgKind::Number, ArgKind::Number}) ||
      !ReadIndex(info[1], &start) || !ReadIndex(info[2], &length) || !RangeEndFits(start, length) ||
      !ReadTimeout(info[3], &timeoutMs)) {
    return RejectBadArgs(env, "setSelectedTextRange(token, start, length, timeoutMs)");
  }
  auto* worker = new SetSelectionRangeWorker(
      env, StateFrom(info), info[0].As<Napi::String>().Utf8Value(), start, length, timeoutMs);
  worker->Queue();
  return worker->Promise();
}

Napi::Value ReplaceRange(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  CFIndex start = 0;
  CFIndex length = 0;
  double timeoutMs = 0;
  if (!ArgsMatch(info, {ArgKind::String, ArgKind::Number, ArgKind::Number, ArgKind::String,
                        ArgKind::Number}) ||
      !ReadIndex(info[1], &start) || !ReadIndex(info[2], &length) || !RangeEndFits(start, length) ||
      !ReadTimeout(info[4], &timeoutMs)) {
    return RejectBadArgs(env, "replaceRange(token, start, length, text, timeoutMs)");
  }
  std::u16string text = info[3].As<Napi::String>().Utf16Value();
  if (!StringLengthFitsCFIndex(text.size())) {
    return RejectBadArgs(env, "replaceRange: text exceeds the native UTF-16 range limit");
  }
  auto* worker =
      new ReplaceRangeWorker(env, StateFrom(info), info[0].As<Napi::String>().Utf8Value(), start,
                             length, std::move(text), timeoutMs);
  worker->Queue();
  return worker->Promise();
}

}  // namespace insertable
