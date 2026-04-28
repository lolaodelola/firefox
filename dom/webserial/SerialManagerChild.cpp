/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/SerialManagerChild.h"

#include "mozilla/dom/PSerialPort.h"
#include "mozilla/dom/Serial.h"
#include "mozilla/dom/SerialPort.h"
#include "mozilla/dom/SerialPortChild.h"
#include "nsThreadUtils.h"

namespace mozilla::dom {

SerialManagerChild::SerialManagerChild(Serial* aSerial) : mSerial(aSerial) {
  AssertIsOnMainThread();
  MOZ_ASSERT(mSerial);
}

SerialManagerChild::~SerialManagerChild() = default;

MOZ_CAN_RUN_SCRIPT_BOUNDARY void SerialManagerChild::ActorDestroy(
    ActorDestroyReason aWhy) {
  AssertIsOnMainThread();
  RefPtr<Serial> serial(mSerial);
  if (serial) {
    serial->ForgetAllPorts();
  }
}

already_AddRefed<SerialPortChild> SerialManagerChild::CreatePort(
    const nsAString& aPortId) {
  AssertIsOnMainThread();

  mozilla::ipc::Endpoint<PSerialPortParent> parentEndpoint;
  mozilla::ipc::Endpoint<PSerialPortChild> childEndpoint;
  nsresult rv = PSerialPort::CreateEndpoints(&parentEndpoint, &childEndpoint);
  if (NS_WARN_IF(NS_FAILED(rv))) {
    return nullptr;
  }

  if (NS_WARN_IF(
          !SendCreatePort(nsString(aPortId), std::move(parentEndpoint)))) {
    return nullptr;
  }
  auto actor = MakeRefPtr<SerialPortChild>();
  if (!childEndpoint.Bind(actor)) {
    return nullptr;
  }

  return actor.forget();
}

}  // namespace mozilla::dom
