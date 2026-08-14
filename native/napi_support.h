#pragma once

#import <ApplicationServices/ApplicationServices.h>

#include <napi.h>

#include <cstddef>
#include <cstdint>
#include <initializer_list>

namespace insertable {

class PromiseWorker : public Napi::AsyncWorker {
 public:
  explicit PromiseWorker(Napi::Env env);

  Napi::Promise Promise();

 protected:
  void OnError(const Napi::Error& error) override;

  Napi::Promise::Deferred deferred_;
};

enum class ArgKind { Number, String };

bool ArgsMatch(const Napi::CallbackInfo& info, std::initializer_list<ArgKind> expected);
Napi::Value RejectBadArgs(Napi::Env env, const char* signature);

bool ReadPid(const Napi::Value& value, pid_t* out);
bool ReadTimeout(const Napi::Value& value, double* out);
bool ReadIndex(const Napi::Value& value, CFIndex* out);
bool ReadOptionalIndex(const Napi::Value& value, CFIndex* out);
bool ReadFiniteFlag(const Napi::Value& value, bool* out);
bool RangeEndFits(CFIndex start, CFIndex length);
bool StringLengthFitsCFIndex(size_t length);

}  // namespace insertable
