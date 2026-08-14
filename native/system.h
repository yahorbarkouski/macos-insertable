#pragma once

#include <napi.h>

#include <sys/types.h>

namespace insertable {

pid_t FocusedAppPid();

Napi::Value IsAccessibilityTrusted(const Napi::CallbackInfo& info);
Napi::Value IsSecureInputEnabled(const Napi::CallbackInfo& info);
Napi::Value SecureInputCulprit(const Napi::CallbackInfo& info);
Napi::Value CurrentModifierFlags(const Napi::CallbackInfo& info);
Napi::Value FrontmostApp(const Napi::CallbackInfo& info);

}  // namespace insertable
