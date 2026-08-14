#include "accessibility.h"
#include "addon_state.h"
#include "input.h"
#include "pasteboard.h"
#include "system.h"

#include <napi.h>

namespace insertable {
namespace {

void Export(Napi::Env env, Napi::Object exports, const char* name,
            Napi::Function::Callback callback, AddonStateHandle* state) {
  exports.Set(name, Napi::Function::New(env, callback, name, state));
}

}  // namespace

Napi::Object InitializeAddon(Napi::Env env, Napi::Object exports) {
  AddonStateHandle* state = CreateAddonState();
  if (napi_add_env_cleanup_hook(env, DeleteAddonState, state) != napi_ok) {
    DeleteAddonState(state);
    Napi::Error::New(env, "failed to register native addon cleanup").ThrowAsJavaScriptException();
    return exports;
  }

  Export(env, exports, "isAccessibilityTrusted", IsAccessibilityTrusted, state);
  Export(env, exports, "isSecureInputEnabled", IsSecureInputEnabled, state);
  Export(env, exports, "secureInputCulprit", SecureInputCulprit, state);
  Export(env, exports, "currentModifierFlags", CurrentModifierFlags, state);
  Export(env, exports, "caretBounds", CaretBounds, state);
  Export(env, exports, "replaceRange", ReplaceRange, state);
  Export(env, exports, "confirmElement", ConfirmElement, state);
  Export(env, exports, "frontmostApp", FrontmostApp, state);
  Export(env, exports, "readFocusedElement", ReadFocusedElement, state);
  Export(env, exports, "readElementState", ReadElementState, state);
  Export(env, exports, "primeAccessibility", PrimeAccessibility, state);
  Export(env, exports, "verifyElement", VerifyElement, state);
  Export(env, exports, "setSelectedText", SetSelectedText, state);
  Export(env, exports, "setSelectedTextRange", SetSelectedTextRange, state);
  Export(env, exports, "casRangeEdit", CasRangeEdit, state);
  Export(env, exports, "setValue", SetValue, state);
  Export(env, exports, "postPaste", PostPaste, state);
  Export(env, exports, "postReturn", PostReturn, state);
  Export(env, exports, "postBackspace", PostBackspace, state);
  Export(env, exports, "typeUnicode", TypeUnicode, state);
  Export(env, exports, "pasteboardChangeCount", PasteboardChangeCount, state);
  Export(env, exports, "pasteboardSnapshot", PasteboardSnapshot, state);
  Export(env, exports, "pasteboardRestore", PasteboardRestore, state);
  Export(env, exports, "pasteboardDiscardSnapshot", PasteboardDiscardSnapshot, state);
  Export(env, exports, "pasteboardWriteText", PasteboardWriteText, state);
  Export(env, exports, "releaseElement", ReleaseElement, state);
  return exports;
}

}  // namespace insertable

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  return insertable::InitializeAddon(env, exports);
}

NODE_API_MODULE(insertable, Init)
