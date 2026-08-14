#pragma once

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

#include <napi.h>

#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>

namespace insertable {

class ElementRegistry {
 public:
  ElementRegistry() = default;
  ~ElementRegistry();

  ElementRegistry(const ElementRegistry&) = delete;
  ElementRegistry& operator=(const ElementRegistry&) = delete;

  std::string Store(AXUIElementRef element);
  AXUIElementRef Copy(const std::string& token);
  void Release(const std::string& token);

 private:
  std::mutex mutex_;
  std::map<std::string, AXUIElementRef> elements_;
  uint64_t counter_ = 0;
};

class PasteboardStash {
 public:
  PasteboardStash() = default;

  PasteboardStash(const PasteboardStash&) = delete;
  PasteboardStash& operator=(const PasteboardStash&) = delete;

  std::string Store(NSArray<NSPasteboardItem*>* items);
  NSArray<NSPasteboardItem*>* Take(const std::string& token);

 private:
  std::mutex mutex_;
  std::map<std::string, NSArray<NSPasteboardItem*>*> items_;
  uint64_t counter_ = 0;
};

struct AddonState {
  ElementRegistry elements;
  PasteboardStash pasteboard;
};

using AddonStateHandle = std::shared_ptr<AddonState>;

AddonStateHandle StateFrom(const Napi::CallbackInfo& info);
AddonStateHandle* CreateAddonState();
void DeleteAddonState(void* data);

}  // namespace insertable
