#pragma once

#include <napi.h>

namespace insertable {

Napi::Value ReadFocusedElement(const Napi::CallbackInfo& info);
Napi::Value ReadElementState(const Napi::CallbackInfo& info);
Napi::Value PrimeAccessibility(const Napi::CallbackInfo& info);
Napi::Value VerifyElement(const Napi::CallbackInfo& info);
Napi::Value SetSelectedText(const Napi::CallbackInfo& info);
Napi::Value SetSelectedTextRange(const Napi::CallbackInfo& info);
Napi::Value CasRangeEdit(const Napi::CallbackInfo& info);
Napi::Value SetValue(const Napi::CallbackInfo& info);
Napi::Value CaretBounds(const Napi::CallbackInfo& info);
Napi::Value ReplaceRange(const Napi::CallbackInfo& info);
Napi::Value ConfirmElement(const Napi::CallbackInfo& info);
Napi::Value ReleaseElement(const Napi::CallbackInfo& info);

}  // namespace insertable
