#import "accessibility.h"
#import "accessibility_internal.h"
#import "addon_state.h"
#import "napi_support.h"

#include <limits>
#include <utility>

namespace insertable {

namespace {

bool CopyStringForRange(AXUIElementRef element, CFRange range, CFStringRef* out) {
  AXValueRef rangeValue = AXValueCreate(kAXValueTypeCFRange, &range);
  if (rangeValue) {
    CFTypeRef result = NULL;
    AXError err = AXUIElementCopyParameterizedAttributeValue(
        element, kAXStringForRangeParameterizedAttribute, rangeValue, &result);
    CFRelease(rangeValue);
    if (err == kAXErrorSuccess && result) {
      if (CFGetTypeID(result) == CFStringGetTypeID()) {
        *out = static_cast<CFStringRef>(result);
        return true;
      }
      CFRelease(result);
    }
  }
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXValueAttribute, &value) != kAXErrorSuccess ||
      !value) {
    return false;
  }
  if (CFGetTypeID(value) != CFStringGetTypeID()) {
    CFRelease(value);
    return false;
  }
  CFStringRef whole = static_cast<CFStringRef>(value);
  CFIndex length = CFStringGetLength(whole);
  if (range.location > length || range.location + range.length > length) {
    CFRelease(whole);
    return false;
  }
  CFStringRef slice = CFStringCreateWithSubstring(kCFAllocatorDefault, whole, range);
  CFRelease(whole);
  if (!slice) return false;
  *out = slice;
  return true;
}

/** Whether the element's text over [location, location+expected.size()) equals `expected`. */
bool RegionEquals(AXUIElementRef element, CFIndex location, const std::u16string& expected) {
  if (expected.empty()) return true;
  CFStringRef actual = NULL;
  if (!CopyStringForRange(element, CFRangeMake(location, static_cast<CFIndex>(expected.size())),
                          &actual)) {
    return false;
  }
  CFStringRef wanted = CFStringCreateWithCharacters(
      kCFAllocatorDefault, reinterpret_cast<const UniChar*>(expected.data()),
      static_cast<CFIndex>(expected.size()));
  bool equal = wanted && CFStringCompare(actual, wanted, 0) == kCFCompareEqualTo;
  CFRelease(actual);
  if (wanted) CFRelease(wanted);
  return equal;
}

/**
 * Compare-and-swap on a text region: the streaming hot path, fused into ONE worker trip.
 *
 * Sequence, all against the pinned element without ever crossing back into JavaScript:
 *   1. prove the element is still its application's focused element (CFEqual — by-reference,
 *      stronger than any attribute comparison)
 *   2. compare: the region [regionStart, regionStart+expected.len) must hold exactly `expected`
 *      — a content precondition strictly stronger than an identity re-read, and the reason no
 *      frontmost check appears here: an Accessibility write lands on the element it references,
 *      so unlike the synthetic-event rungs there is no misdirection for a frontmost check to
 *      prevent
 *   3. swap: select the TS-computed edit span inside the region and replace the selection
 *   4. verify the resulting region text, with one blocking settle retry for views that mirror
 *      their text asynchronously
 *   5. park the caret at the TS-chosen position — skipped when the live caret was not where the
 *      last update left it, because then the user moved it and it is not ours to move back
 *
 * Every offset is UTF-16 units on both sides (JavaScript strings and CFRange agree), so values
 * pass through untranslated. The fallback ladder and every retry POLICY stay in TypeScript;
 * this is one atomic primitive, not a strategy.
 */
class CasRangeEditWorker : public PromiseWorker {
 public:
  CasRangeEditWorker(Napi::Env env, AddonStateHandle state, std::string token, CFIndex regionStart,
                     std::u16string expected, CFIndex editStart, CFIndex editEnd,
                     std::u16string replacement, CFIndex parkAt, CFIndex expectedCaret,
                     bool preferSplice, double timeoutMs)
      : PromiseWorker(env),
        addonState_(std::move(state)),
        token_(std::move(token)),
        regionStart_(regionStart),
        expected_(std::move(expected)),
        editStart_(editStart),
        editEnd_(editEnd),
        replacement_(std::move(replacement)),
        parkAt_(parkAt),
        expectedCaret_(expectedCaret),
        preferSplice_(preferSplice),
        timeoutMs_(timeoutMs) {}

  void Execute() override {
    AXUIElementRef element = addonState_->elements.Copy(token_);
    if (!element) {
      reason_ = "element-gone";
      return;
    }
    ApplyTimeout(element, timeoutMs_);

    pid_t pid = -1;
    if (AXUIElementGetPid(element, &pid) != kAXErrorSuccess) {
      CFRelease(element);
      reason_ = "element-gone";
      return;
    }
    AXUIElementRef focused = CopyFocusedElement(pid, timeoutMs_);
    if (!focused) {
      CFRelease(element);
      reason_ = "element-gone";
      return;
    }
    bool sameElement = CFEqual(element, focused) ? true : false;
    CFRelease(focused);
    if (!sameElement) {
      CFRelease(element);
      reason_ = "element-changed";
      return;
    }

    // The user's caret, before we touch anything: if it is not where the last update parked
    // it, the user moved it and the park below must not fight them.
    bool caretIsOurs = expectedCaret_ < 0;
    CFRange liveSelection = CFRangeMake(0, 0);
    if (CopyAxRange(element, kAXSelectedTextRangeAttribute, &liveSelection)) {
      if (expectedCaret_ >= 0) {
        caretIsOurs = liveSelection.length == 0 && liveSelection.location == expectedCaret_;
      }
    }

    if (!RegionEquals(element, regionStart_, expected_)) {
      CFRelease(element);
      reason_ = "region-mismatch";
      return;
    }

    CFRange editRange = CFRangeMake(regionStart_ + editStart_, editEnd_ - editStart_);
    AXValueRef editValue = AXValueCreate(kAXValueTypeCFRange, &editRange);
    if (!editValue) {
      CFRelease(element);
      reason_ = "select-failed";
      return;
    }
    AXError selectError =
        AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute, editValue);
    CFRelease(editValue);
    if (selectError != kAXErrorSuccess) {
      CFRelease(element);
      reason_ = "select-failed";
      return;
    }
    // Placement must be read back on the mirror-settle schedule: Chromium reports the OLD
    // selection in the same trip and lands the new one moments later.
    bool placedOk = false;
    for (int attempt = 0; attempt <= kMirrorSettleSteps && !placedOk; attempt += 1) {
      if (attempt > 0) usleep(kMirrorSettleUs[attempt - 1]);
      CFRange placed = CFRangeMake(-1, -1);
      placedOk = CopyAxRange(element, kAXSelectedTextRangeAttribute, &placed) &&
                 placed.location == editRange.location && placed.length == editRange.length;
    }
    if (!placedOk) {
      CFRelease(element);
      reason_ = "select-failed";
      return;
    }

    // The final region = expected with the edit span replaced, spliced here mechanically from
    // the TS-provided pieces.
    std::u16string finalRegion = expected_.substr(0, static_cast<size_t>(editStart_));
    finalRegion += replacement_;
    finalRegion += expected_.substr(static_cast<size_t>(editEnd_));

    bool landed = false;
    if (!preferSplice_) {
      CFStringRef replacementValue = CFStringCreateWithCharacters(
          kCFAllocatorDefault, reinterpret_cast<const UniChar*>(replacement_.data()),
          static_cast<CFIndex>(replacement_.size()));
      if (!replacementValue) {
        CFRelease(element);
        reason_ = "write-failed";
        return;
      }
      AXError writeError =
          AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute, replacementValue);
      CFRelease(replacementValue);
      // Quick check only — immediate plus one short settle. Exhausting the full schedule here
      // would bill every update in an engine that ignores this attribute for the discovery.
      if (writeError == kAXErrorSuccess) {
        for (int attempt = 0; attempt < 2 && !landed; attempt += 1) {
          if (attempt > 0) usleep(kMirrorSettleUs[0]);
          landed = RegionEquals(element, regionStart_, finalRegion);
        }
      }
      if (landed) via_ = "selected-text";
    }

    if (!landed) {
      // Second swap tactic, same contract: Chromium accepts selection-range and whole-value
      // writes but silently ignores kAXSelectedTextAttribute (measured — reported success,
      // text unchanged). Splice the region into the full value and write THAT. Costs
      // O(document) payload where the first tactic is O(edit), which is why it is the
      // fallback — and why the caller can pass preferSplice once it learns which tactic the
      // target answers to.
      landed = SpliceValueAndVerify(element, finalRegion);
      if (landed) via_ = "value-splice";
    }
    if (!landed) {
      CFRelease(element);
      reason_ = "verify-failed";
      return;
    }

    if (parkAt_ >= 0 && caretIsOurs) {
      CFRange park = CFRangeMake(parkAt_, 0);
      AXValueRef parkValue = AXValueCreate(kAXValueTypeCFRange, &park);
      if (parkValue) {
        AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute, parkValue);
        CFRelease(parkValue);
        parked_ = true;
      }
    }
    ok_ = true;
    CFRelease(element);
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Object result = Napi::Object::New(env);
    result.Set("ok", Napi::Boolean::New(env, ok_));
    result.Set("reason",
               reason_.empty() ? env.Null() : Napi::String::New(env, reason_).As<Napi::Value>());
    result.Set("parked", Napi::Boolean::New(env, parked_));
    result.Set("via", via_.empty() ? env.Null() : Napi::String::New(env, via_).As<Napi::Value>());
    deferred_.Resolve(result);
  }

 private:
  /**
   * Rewrites the whole value with the draft region replaced by `finalRegion`, verifying on the
   * settle schedule. The full value is re-read HERE, in the same worker as the precondition,
   * so text outside the region is the freshest readable state.
   */
  bool SpliceValueAndVerify(AXUIElementRef element, const std::u16string& finalRegion) {
    CFTypeRef current = NULL;
    if (AXUIElementCopyAttributeValue(element, kAXValueAttribute, &current) != kAXErrorSuccess ||
        !current) {
      return false;
    }
    if (CFGetTypeID(current) != CFStringGetTypeID()) {
      CFRelease(current);
      return false;
    }
    CFStringRef value = static_cast<CFStringRef>(current);

    // Rich composers render their placeholder as literal text in the accessibility value while
    // the field is empty. Preserving that as "surrounding text" would MATERIALIZE the
    // placeholder into the document — the app's own input path clears it, a raw value write
    // does not. Exact equality is not enough (composers keep a trailing newline or zero-width
    // artifact after the rendered placeholder), so the check is placeholder-prefix plus a
    // short junk-only tail — mirroring isPlaceholderPhantom on the TypeScript side; the two
    // must agree or the layers disagree about whether content exists.
    CFTypeRef placeholderRef = NULL;
    bool valueIsPlaceholder = false;
    if (CFStringGetLength(value) > 0 &&
        AXUIElementCopyAttributeValue(element, CFSTR("AXPlaceholderValue"), &placeholderRef) ==
            kAXErrorSuccess &&
        placeholderRef) {
      if (CFGetTypeID(placeholderRef) == CFStringGetTypeID()) {
        CFStringRef placeholder = static_cast<CFStringRef>(placeholderRef);
        CFIndex placeholderLength = CFStringGetLength(placeholder);
        CFIndex valueLength = CFStringGetLength(value);
        if (placeholderLength > 0 && valueLength >= placeholderLength &&
            valueLength <= placeholderLength + 2 && CFStringHasPrefix(value, placeholder)) {
          bool tailIsJunk = true;
          for (CFIndex i = placeholderLength; i < valueLength && tailIsJunk; i += 1) {
            UniChar unit = CFStringGetCharacterAtIndex(value, i);
            tailIsJunk = unit == u'\n' || unit == u'\r' || unit == u' ' || unit == u'\t' ||
                         unit == 0x200B || unit == 0x200C || unit == 0xFEFF || unit == 0x2060 ||
                         unit == 0xFFFC;
          }
          valueIsPlaceholder = tailIsJunk;
        }
      }
      CFRelease(placeholderRef);
    }
    if (valueIsPlaceholder) {
      CFRelease(value);
      // Phantom-relative offsets would splice into text that is not really there; the draft's
      // coordinates are only meaningful against empty content when it starts at zero.
      if (regionStart_ != 0 || !expected_.empty()) return false;
      CFStringRef next = CFStringCreateWithCharacters(
          kCFAllocatorDefault, reinterpret_cast<const UniChar*>(finalRegion.data()),
          static_cast<CFIndex>(finalRegion.size()));
      if (!next) return false;
      AXError wrote = AXUIElementSetAttributeValue(element, kAXValueAttribute, next);
      CFRelease(next);
      if (wrote != kAXErrorSuccess) return false;
      for (int attempt = 0; attempt <= kMirrorSettleSteps; attempt += 1) {
        if (attempt > 0) usleep(kMirrorSettleUs[attempt - 1]);
        if (RegionEquals(element, 0, finalRegion)) return true;
      }
      return false;
    }

    CFIndex length = CFStringGetLength(value);
    CFIndex regionEnd = regionStart_ + static_cast<CFIndex>(expected_.size());
    if (regionStart_ > length || regionEnd > length) {
      CFRelease(value);
      return false;
    }

    std::u16string whole(static_cast<size_t>(length), u'\0');
    CFStringGetCharacters(value, CFRangeMake(0, length), reinterpret_cast<UniChar*>(whole.data()));
    CFRelease(value);
    // The region must still hold what the precondition saw — the splice is positional, and a
    // mid-flight edit would make these offsets someone else's text.
    if (whole.compare(static_cast<size_t>(regionStart_), expected_.size(), expected_) != 0) {
      return false;
    }
    whole.replace(static_cast<size_t>(regionStart_), expected_.size(), finalRegion);

    CFStringRef next = CFStringCreateWithCharacters(kCFAllocatorDefault,
                                                    reinterpret_cast<const UniChar*>(whole.data()),
                                                    static_cast<CFIndex>(whole.size()));
    if (!next) return false;
    AXError wrote = AXUIElementSetAttributeValue(element, kAXValueAttribute, next);
    CFRelease(next);
    if (wrote != kAXErrorSuccess) return false;

    for (int attempt = 0; attempt <= kMirrorSettleSteps; attempt += 1) {
      if (attempt > 0) usleep(kMirrorSettleUs[attempt - 1]);
      if (RegionEquals(element, regionStart_, finalRegion)) return true;
    }
    return false;
  }

  AddonStateHandle addonState_;
  std::string token_;
  CFIndex regionStart_;
  std::u16string expected_;
  CFIndex editStart_;
  CFIndex editEnd_;
  std::u16string replacement_;
  CFIndex parkAt_;
  CFIndex expectedCaret_;
  bool preferSplice_;
  double timeoutMs_;
  bool ok_ = false;
  bool parked_ = false;
  std::string reason_;
  std::string via_;
};

}  // namespace

Napi::Value CasRangeEdit(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  CFIndex regionStart = 0;
  CFIndex editStart = 0;
  CFIndex editEnd = 0;
  CFIndex parkAt = -1;
  CFIndex expectedCaret = -1;
  bool preferSplice = false;
  double timeoutMs = 0;
  if (!ArgsMatch(info, {ArgKind::String, ArgKind::Number, ArgKind::String, ArgKind::Number,
                        ArgKind::Number, ArgKind::String, ArgKind::Number, ArgKind::Number,
                        ArgKind::Number, ArgKind::Number}) ||
      !ReadIndex(info[1], &regionStart) || !ReadIndex(info[3], &editStart) ||
      !ReadIndex(info[4], &editEnd) || !ReadOptionalIndex(info[6], &parkAt) ||
      !ReadOptionalIndex(info[7], &expectedCaret) || !ReadFiniteFlag(info[8], &preferSplice) ||
      !ReadTimeout(info[9], &timeoutMs)) {
    return RejectBadArgs(env, "casRangeEdit(token, regionStart, expected, editStart, editEnd, "
                              "replacement, parkAt, expectedCaret, preferSplice, timeoutMs)");
  }

  std::u16string expected = info[2].As<Napi::String>().Utf16Value();
  std::u16string replacement = info[5].As<Napi::String>().Utf16Value();
  if (!StringLengthFitsCFIndex(expected.size()) || !StringLengthFitsCFIndex(replacement.size()) ||
      editEnd < editStart || static_cast<size_t>(editEnd) > expected.size() ||
      !RangeEndFits(regionStart, static_cast<CFIndex>(expected.size()))) {
    return RejectBadArgs(
        env, "casRangeEdit: needs 0 <= editStart <= editEnd <= expected.length, regionStart >= 0");
  }
  size_t unchangedUnits = expected.size() - static_cast<size_t>(editEnd - editStart);
  if (replacement.size() >
          static_cast<size_t>(std::numeric_limits<CFIndex>::max()) - unchangedUnits ||
      !RangeEndFits(regionStart, static_cast<CFIndex>(unchangedUnits + replacement.size()))) {
    return RejectBadArgs(env, "casRangeEdit: resulting UTF-16 range is too large");
  }

  auto* worker = new CasRangeEditWorker(
      env, StateFrom(info), info[0].As<Napi::String>().Utf8Value(), regionStart,
      std::move(expected), editStart, editEnd, std::move(replacement), parkAt, expectedCaret,
      preferSplice, timeoutMs);
  worker->Queue();
  return worker->Promise();
}

}  // namespace insertable
