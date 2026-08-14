#pragma once

#include <napi.h>

namespace insertable {

Napi::Value PostPaste(const Napi::CallbackInfo& info);
Napi::Value PostReturn(const Napi::CallbackInfo& info);
Napi::Value PostBackspace(const Napi::CallbackInfo& info);
Napi::Value TypeUnicode(const Napi::CallbackInfo& info);

}  // namespace insertable
