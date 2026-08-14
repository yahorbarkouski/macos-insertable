#pragma once

#include <napi.h>

namespace insertable {

Napi::Value PasteboardChangeCount(const Napi::CallbackInfo& info);
Napi::Value PasteboardSnapshot(const Napi::CallbackInfo& info);
Napi::Value PasteboardRestore(const Napi::CallbackInfo& info);
Napi::Value PasteboardDiscardSnapshot(const Napi::CallbackInfo& info);
Napi::Value PasteboardWriteText(const Napi::CallbackInfo& info);

}  // namespace insertable
