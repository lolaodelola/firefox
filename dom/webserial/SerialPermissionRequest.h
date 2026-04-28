/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_SerialPermissionRequest_h
#define mozilla_dom_SerialPermissionRequest_h

#include "mozilla/dom/SerialBinding.h"
#include "mozilla/dom/SerialTypes.h"
#include "nsContentPermissionHelper.h"
#include "nsIRunnable.h"
#include "nsITimer.h"

namespace mozilla::dom {

class Promise;
class Serial;

class SerialPermissionRequest final : public ContentPermissionRequestBase,
                                      public nsIRunnable {
 public:
  SerialPermissionRequest(nsPIDOMWindowInner* aWindow, Promise* aPromise,
                          const SerialPortRequestOptions& aOptions,
                          Serial* aSerial);

  NS_DECL_ISUPPORTS_INHERITED
  NS_DECL_NSIRUNNABLE
  NS_DECL_CYCLE_COLLECTION_CLASS_INHERITED(SerialPermissionRequest,
                                           ContentPermissionRequestBase)

  // nsIContentPermissionRequest
  NS_IMETHOD Cancel(void) override;
  NS_IMETHOD Allow(JS::Handle<JS::Value> choices) override;
  NS_IMETHOD GetTypes(nsIArray** aTypes) override;

  // Check if auto-select is enabled for testing
  bool ShouldAutoselect() const;

 private:
  ~SerialPermissionRequest() override = default;
  nsresult DoPrompt();
  void CancelWithRandomizedDelay();
  // Returns whether filters were applied successfully
  bool FilterPorts(nsTArray<IPCSerialPortInfo>& aPorts);
  bool IsSitePermAllow();
  bool IsSitePermDeny();

  // Track why Cancel() is being called to determine the appropriate error type
  enum class CancellationReason {
    UserCancelled,  // User clicked Cancel in the port chooser dialog
    AddonDenied,    // Site permission addon installation was denied
    InternalError   // IPC failure, prompt failure, etc.
  };

  // If we're canceling on a timer, we need to hold a strong ref while it's
  // outstanding
  nsCOMPtr<nsITimer> mCancelTimer;

  // Promise for returning SerialPort on request success
  RefPtr<Promise> mPromise;
  SerialPortRequestOptions mOptions;
  nsTArray<IPCSerialPortInfo> mAvailablePorts;
  RefPtr<Serial> mSerial;

  CancellationReason mCancellationReason = CancellationReason::UserCancelled;
};

}  // namespace mozilla::dom

#endif  // mozilla_dom_SerialPermissionRequest_h
