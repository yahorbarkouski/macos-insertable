{
  "targets": [
    {
      "target_name": "insertable",
      "conditions": [
        [
          "OS=='mac'",
          {
            "cflags!": ["-fno-exceptions"],
            "cflags_cc!": ["-fno-exceptions"],
            "sources": [
              "native/accessibility_cas.mm",
              "native/accessibility_edit.mm",
              "native/accessibility_internal.mm",
              "native/accessibility_read.mm",
              "native/addon.mm",
              "native/addon_state.mm",
              "native/input.mm",
              "native/napi_support.mm",
              "native/pasteboard.mm",
              "native/system.mm"
            ],
            "include_dirs": [
              "<!@(node -p \"require('node-addon-api').include\")"
            ],
            "defines": [
              "NAPI_DISABLE_CPP_EXCEPTIONS",
              "NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS"
            ],
            "xcode_settings": {
              "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
              "CLANG_CXX_LIBRARY": "libc++",
              "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
              # Objects here outlive the call that made them — a pasteboard snapshot is held
              # across the paste it protects. Without ARC those stores are raw pointers into a
              # drained autorelease pool, which is a use-after-free rather than a leak.
              # insertable.mm refuses to compile without this.
              "CLANG_ENABLE_OBJC_ARC": "YES",
              "MACOSX_DEPLOYMENT_TARGET": "11.0",
              "OTHER_LDFLAGS": [
                "-framework AppKit",
                "-framework ApplicationServices",
                "-framework Carbon",
                "-framework CoreGraphics",
                "-framework CoreFoundation",
                "-framework IOKit"
              ]
            }
          }
        ]
      ]
    }
  ]
}
