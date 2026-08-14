#import "addon_state.h"

#if !__has_feature(objc_arc)
#error "Native sources must be compiled with ARC (CLANG_ENABLE_OBJC_ARC in binding.gyp)."
#endif

namespace insertable {

ElementRegistry::~ElementRegistry() {
  std::lock_guard<std::mutex> guard(mutex_);
  for (const auto& [token, element] : elements_) {
    (void)token;
    CFRelease(element);
  }
}

std::string ElementRegistry::Store(AXUIElementRef element) {
  std::lock_guard<std::mutex> guard(mutex_);
  std::string token = "ax-" + std::to_string(++counter_);
  CFRetain(element);
  elements_[token] = element;
  return token;
}

AXUIElementRef ElementRegistry::Copy(const std::string& token) {
  std::lock_guard<std::mutex> guard(mutex_);
  auto found = elements_.find(token);
  if (found == elements_.end()) return NULL;
  CFRetain(found->second);
  return found->second;
}

void ElementRegistry::Release(const std::string& token) {
  std::lock_guard<std::mutex> guard(mutex_);
  auto found = elements_.find(token);
  if (found == elements_.end()) return;
  CFRelease(found->second);
  elements_.erase(found);
}

std::string PasteboardStash::Store(NSArray<NSPasteboardItem*>* items) {
  std::lock_guard<std::mutex> guard(mutex_);
  std::string token = "pb-" + std::to_string(++counter_);
  items_[token] = items;
  return token;
}

NSArray<NSPasteboardItem*>* PasteboardStash::Take(const std::string& token) {
  std::lock_guard<std::mutex> guard(mutex_);
  auto found = items_.find(token);
  if (found == items_.end()) return nil;
  NSArray<NSPasteboardItem*>* items = found->second;
  items_.erase(found);
  return items;
}

AddonStateHandle StateFrom(const Napi::CallbackInfo& info) {
  auto* state = static_cast<AddonStateHandle*>(info.Data());
  return state ? *state : nullptr;
}

AddonStateHandle* CreateAddonState() {
  return new AddonStateHandle(std::make_shared<AddonState>());
}

void DeleteAddonState(void* data) { delete static_cast<AddonStateHandle*>(data); }

}  // namespace insertable
