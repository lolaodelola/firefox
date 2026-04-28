/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_Serial_h
#define mozilla_dom_Serial_h

#include "mozilla/DOMEventTargetHelper.h"
#include "mozilla/WeakPtr.h"
#include "mozilla/dom/PSerialPortChild.h"
#include "mozilla/dom/SerialPortInfo.h"
#include "mozilla/ipc/Endpoint.h"
#include "nsCOMPtr.h"
#include "nsTArray.h"

namespace mozilla::dom {

class Promise;
class SerialManagerChild;
class SerialPort;
struct SerialPortRequestOptions;
struct SerialPortFilter;

class Serial final : public DOMEventTargetHelper, public SupportsWeakPtr {
 public:
  NS_DECL_ISUPPORTS_INHERITED
  NS_DECL_CYCLE_COLLECTION_CLASS_INHERITED(Serial, DOMEventTargetHelper)

  explicit Serial(nsPIDOMWindowInner* aWindow);
  explicit Serial(nsIGlobalObject* aGlobal);

  JSObject* WrapObject(JSContext* aCx,
                       JS::Handle<JSObject*> aGivenProto) override;

  already_AddRefed<Promise> RequestPort(
      const SerialPortRequestOptions& aOptions, ErrorResult& aRv);

  already_AddRefed<Promise> GetPorts(ErrorResult& aRv);

  IMPL_EVENT_HANDLER(connect)
  IMPL_EVENT_HANDLER(disconnect)

  // Apply filters to a list of ports, removing ports that don't match
  // Returns whether filters were applied successfully. If this function
  // returns false, this means one of the bluetoothServiceClassId's
  // was formatted wrong.
  static bool ApplyPortFilters(nsTArray<IPCSerialPortInfo>& aPorts,
                               const Sequence<SerialPortFilter>& aFilters);

  void Shutdown();

  SerialManagerChild* GetOrCreateManagerChild();

  void DisconnectFromOwner() override;

  MOZ_CAN_RUN_SCRIPT void ForgetAllPorts();

  already_AddRefed<Promise> SimulateDeviceConnection(
      const nsAString& aDeviceId, const nsAString& aDevicePath,
      uint16_t aVendorId, uint16_t aProductId, ErrorResult& aRv);

  already_AddRefed<Promise> SimulateDeviceDisconnection(
      const nsAString& aDeviceId, ErrorResult& aRv);

  already_AddRefed<Promise> RemoveAllMockDevices(ErrorResult& aRv);

  already_AddRefed<Promise> ResetToDefaultMockDevices(ErrorResult& aRv);

  // Find or create a SerialPort for the given info. On the main thread,
  // eagerly creates and binds a PSerialPort actor. Returns nullptr on failure.
  RefPtr<SerialPort> GetOrCreatePort(const IPCSerialPortInfo& aInfo);

  // Remove the port from the granted list and mark it forgotten.
  MOZ_CAN_RUN_SCRIPT_BOUNDARY void ForgetPort(const nsAString& aPortId);

  bool GetAutoselectPorts(ErrorResult& aRv) const;
  void SetAutoselectPorts(bool aAutoselect, ErrorResult& aRv);

  bool AutoselectPorts() const { return mAutoselectPorts; }

 private:
  ~Serial() override;

  already_AddRefed<Promise> RequestPortWithTestingAutoselect(
      const SerialPortRequestOptions& aOptions, RefPtr<Promise> aPromise);

  // Returns the manager child if the testing preference is enabled, otherwise
  // sets a NotSupportedError on aRv and returns nullptr.
  SerialManagerChild* GetManagerChildForTesting(ErrorResult& aRv);

  // The single list of granted SerialPort objects for this context.
  nsTArray<RefPtr<SerialPort>> mPorts;

  RefPtr<SerialManagerChild> mManagerChild;

  // True if shutdown has started
  bool mHasShutdown = false;

  // Auto-select port in testing mode (defaults to true since most tests want
  // this)
  bool mAutoselectPorts = true;
};

}  // namespace mozilla::dom

#endif  // mozilla_dom_Serial_h
