#import "napi_support.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace insertable {
namespace {

constexpr double kMaxSafeInteger = 9007199254740991.0;

bool ReadInteger(const Napi::Value& value, double minimum, double maximum, int64_t* out) {
  if (!value.IsNumber()) return false;
  double number = value.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(number) || std::trunc(number) != number || number < minimum ||
      number > maximum || number < -kMaxSafeInteger || number > kMaxSafeInteger) {
    return false;
  }
  *out = static_cast<int64_t>(number);
  return true;
}

}  // namespace

PromiseWorker::PromiseWorker(Napi::Env env)
    : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)) {}

Napi::Promise PromiseWorker::Promise() { return deferred_.Promise(); }

void PromiseWorker::OnError(const Napi::Error& error) { deferred_.Reject(error.Value()); }

bool ArgsMatch(const Napi::CallbackInfo& info, std::initializer_list<ArgKind> expected) {
  if (info.Length() < expected.size()) return false;
  size_t index = 0;
  for (ArgKind kind : expected) {
    const Napi::Value value = info[index];
    if (kind == ArgKind::Number && !value.IsNumber()) return false;
    if (kind == ArgKind::String && !value.IsString()) return false;
    index += 1;
  }
  return true;
}

Napi::Value RejectBadArgs(Napi::Env env, const char* signature) {
  auto deferred = Napi::Promise::Deferred::New(env);
  deferred.Reject(Napi::TypeError::New(env, signature).Value());
  return deferred.Promise();
}

bool ReadPid(const Napi::Value& value, pid_t* out) {
  int64_t parsed = 0;
  if (!ReadInteger(value, 1, std::numeric_limits<pid_t>::max(), &parsed)) return false;
  *out = static_cast<pid_t>(parsed);
  return true;
}

bool ReadTimeout(const Napi::Value& value, double* out) {
  if (!value.IsNumber()) return false;
  double parsed = value.As<Napi::Number>().DoubleValue();
  constexpr double maximum = static_cast<double>(std::numeric_limits<float>::max()) * 1000.0;
  if (!std::isfinite(parsed) || parsed < 0 || parsed > maximum) return false;
  *out = parsed;
  return true;
}

bool ReadIndex(const Napi::Value& value, CFIndex* out) {
  int64_t parsed = 0;
  double maximum =
      std::min(kMaxSafeInteger, static_cast<double>(std::numeric_limits<CFIndex>::max()));
  if (!ReadInteger(value, 0, maximum, &parsed)) return false;
  *out = static_cast<CFIndex>(parsed);
  return true;
}

bool ReadOptionalIndex(const Napi::Value& value, CFIndex* out) {
  int64_t parsed = 0;
  double maximum =
      std::min(kMaxSafeInteger, static_cast<double>(std::numeric_limits<CFIndex>::max()));
  if (!ReadInteger(value, -kMaxSafeInteger, maximum, &parsed)) return false;
  *out = parsed < 0 ? static_cast<CFIndex>(-1) : static_cast<CFIndex>(parsed);
  return true;
}

bool ReadFiniteFlag(const Napi::Value& value, bool* out) {
  if (!value.IsNumber()) return false;
  double parsed = value.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(parsed)) return false;
  *out = parsed != 0;
  return true;
}

bool RangeEndFits(CFIndex start, CFIndex length) {
  return start >= 0 && length >= 0 && start <= std::numeric_limits<CFIndex>::max() - length;
}

bool StringLengthFitsCFIndex(size_t length) {
  return length <= static_cast<size_t>(std::numeric_limits<CFIndex>::max());
}

}  // namespace insertable
