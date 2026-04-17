/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Regression test for Bug 2031968: deadlock when DNS completion callbacks are
// invoked while nsHostResolver's mDBLock write lock is held.

#include "gtest/gtest.h"

#include "nsHostRecord.h"
#include "nsHostResolver.h"
#include "mozilla/Atomics.h"

#include <chrono>
#include <future>
#include <thread>

using namespace mozilla;
using namespace mozilla::net;

namespace {

// A callback that, on its first invocation, immediately calls ResolveHost
// again on the same resolver.
class ReentrantCallback final : public nsResolveHostCallback {
 public:
  NS_DECL_ISUPPORTS

  ReentrantCallback(nsHostResolver* aResolver, bool aShouldReenter)
      : mResolver(aResolver),
        mShouldReenter(aShouldReenter),
        mCompleted(false) {}

  void OnResolveHostComplete(nsHostResolver* aResolver, nsHostRecord* aRecord,
                             nsresult aStatus) override {
    if (mShouldReenter) {
      RefPtr<ReentrantCallback> inner =
          new ReentrantCallback(mResolver, /* aShouldReenter */ false);
      mResolver->ResolveHost(
          "localhost"_ns, ""_ns, -1, nsIDNSService::RESOLVE_TYPE_DEFAULT,
          OriginAttributes(), nsIDNSService::RESOLVE_DEFAULT_FLAGS,
          PR_AF_UNSPEC, inner);
    }
    mCompleted = true;
  }

  bool EqualsAsyncListener(nsIDNSListener* aListener) override { return false; }

  size_t SizeOfIncludingThis(
      mozilla::MallocSizeOf aMallocSizeOf) const override {
    return aMallocSizeOf(this);
  }

  RefPtr<nsHostResolver> mResolver;
  const bool mShouldReenter;
  Atomic<bool> mCompleted;

 private:
  ~ReentrantCallback() = default;
};

NS_IMPL_ISUPPORTS0(ReentrantCallback)

}  // namespace

// Verify that a DNS completion callback can safely call back into ResolveHost.
TEST(TestDNS, ResolveHostCallbackCanReenterResolveHost)
{
  RefPtr<nsHostResolver> resolver;
  nsresult rv = nsHostResolver::Create(getter_AddRefs(resolver));
  ASSERT_NS_SUCCEEDED(rv);

  // Run the potentially-deadlocking work on a worker thread so the main
  // thread can apply a timeout.  The promise is moved into the lambda so
  // both the promise and the resolver RefPtr are owned by the lambda itself;
  // no dangling references exist if the thread is detached while deadlocked.
  std::promise<bool> completionPromise;
  std::future<bool> completionFuture = completionPromise.get_future();

  std::thread worker([resolver, p = std::move(completionPromise)]() mutable {
    RefPtr<ReentrantCallback> callback =
        new ReentrantCallback(resolver, /* aShouldReenter */ true);

    resolver->ResolveHost(
        "localhost"_ns, ""_ns, -1, nsIDNSService::RESOLVE_TYPE_DEFAULT,
        OriginAttributes(), nsIDNSService::RESOLVE_DEFAULT_FLAGS, PR_AF_UNSPEC,
        callback);

    p.set_value(callback->mCompleted);
  });

  // Detach so the destructor doesn't block if the worker is deadlocked.
  worker.detach();

  constexpr auto kTimeout = std::chrono::seconds(10);
  const auto status = completionFuture.wait_for(kTimeout);

  EXPECT_NE(status, std::future_status::timeout)
      << "Deadlock detected (Bug 2031968): OnResolveHostComplete was invoked "
         "while mDBLock write was held; the callback could not re-enter "
         "ResolveHost.  Fix: move callback invocation outside the lock scope.";

  if (status != std::future_status::timeout) {
    resolver->Shutdown();
  }
}
