#pragma once

#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>

#include <napi.h>

#include <string>
#include <unistd.h>
#include <vector>

namespace insertable {

extern const useconds_t kMirrorSettleUs[3];
constexpr int kMirrorSettleSteps = 3;

std::string CFStringToStd(CFStringRef value);
CFStringRef CreateCFString(const std::string& value);

bool CopyAxString(AXUIElementRef element, CFStringRef attribute, std::string* out);
bool CopyAxStringCapped(AXUIElementRef element, CFStringRef attribute, CFIndex maxChars,
                        std::string* out);
bool CopyAxRange(AXUIElementRef element, CFStringRef attribute, CFRange* out);
bool CopyAxLong(AXUIElementRef element, CFStringRef attribute, long* out);
bool CopyAxBool(AXUIElementRef element, CFStringRef attribute, bool fallback);
bool CopyAxPoint(AXUIElementRef element, CFStringRef attribute, CGPoint* out);
bool CopyAxSize(AXUIElementRef element, CFStringRef attribute, CGSize* out);
bool FrameIntersectsAnyDisplay(CGRect frame);
bool IsAttributeSettable(AXUIElementRef element, CFStringRef attribute);
std::vector<std::string> CopyAttributeNames(AXUIElementRef element);

struct TextState {
  bool hasValue = false;
  std::string value;
  std::string selectedText;
  bool hasSelection = false;
  long selectionStart = 0;
  long selectionLength = 0;
  long numberOfCharacters = -1;
};

void ReadTextState(AXUIElementRef element, CFIndex valueMaxChars, TextState* state);
Napi::Object TextStateToObject(Napi::Env env, const TextState& state);

struct ElementIdentity {
  std::string role;
  std::string subrole;
  std::string title;
  std::string description;
  std::string placeholder;
  std::string identifier;
};

void ReadIdentity(AXUIElementRef element, ElementIdentity* identity);
void AssignIdentity(Napi::Object object, const ElementIdentity& identity);
void ApplyTimeout(AXUIElementRef element, double timeoutMs);
AXUIElementRef CopyFocusedElement(pid_t pid, double timeoutMs);

}  // namespace insertable
