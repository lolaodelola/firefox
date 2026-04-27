/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/SerialManagerParent.h"

#include "SerialLogging.h"
#include "TestSerialPlatformService.h"
#include "mozilla/Services.h"
#include "mozilla/StaticPrefs_dom.h"
#include "mozilla/dom/BrowsingContext.h"
#include "mozilla/dom/CanonicalBrowsingContext.h"
#include "mozilla/dom/PSerialPort.h"
#include "mozilla/dom/SerialPlatformService.h"
#include "mozilla/dom/SerialPortParent.h"
#include "mozilla/ipc/Endpoint.h"
#include "nsIObserverService.h"
#include "nsThreadUtils.h"

namespace mozilla::dom {

NS_IMPL_ISUPPORTS(SerialDeviceChangeProxy, nsIObserver)

SerialDeviceChangeProxy::SerialDeviceChangeProxy(uint64_t aBrowserId)
    : mBrowserId(aBrowserId) {}

SerialDeviceChangeProxy::~SerialDeviceChangeProxy() = default;

void SerialDeviceChangeProxy::AddPortActor(SerialPortParent* aActor) {
  MutexAutoLock lock(mMutex);
  mPortActors.AppendElement(aActor);
}

void SerialDeviceChangeProxy::RemovePortActor(SerialPortParent* aActor) {
  MutexAutoLock lock(mMutex);
  mPortActors.RemoveElement(aActor);
}

nsTArray<RefPtr<SerialPortParent>> SerialDeviceChangeProxy::ActorsById(
    const nsAString& aPortId) {
  nsTArray<RefPtr<SerialPortParent>> actors;
  MutexAutoLock lock(mMutex);
  for (const auto& actor : mPortActors) {
    if (actor->PortIdMatches(aPortId)) {
      actors.AppendElement(actor);
    }
  }
  return actors;
}

void SerialDeviceChangeProxy::RevokeAllPorts() {
  nsTArray<RefPtr<SerialPortParent>> actors;
  {
    MutexAutoLock lock(mMutex);
    actors.SwapElements(mPortActors);
  }

  RefPtr<SerialPlatformService> service = SerialPlatformService::GetInstance();
  if (!service || actors.IsEmpty()) {
    return;
  }

  service->IOThread()->Dispatch(
      NS_NewRunnableFunction("SerialDeviceChangeProxy::RevokeAllPorts",
                             [actors = std::move(actors)]() {
                               for (const auto& actor : actors) {
                                 if (actor->CanSend()) {
                                   actor->Close();
                                 }
                               }
                             }));
}

void SerialDeviceChangeProxy::OnPortConnected(
    const IPCSerialPortInfo& aPortInfo) {
  RefPtr<SerialPlatformService> service = SerialPlatformService::GetInstance();
  if (!service) {
    return;
  }

  auto actors = ActorsById(aPortInfo.id());
  if (!actors.IsEmpty()) {
    service->IOThread()->Dispatch(
        NS_NewRunnableFunction("SerialDeviceChangeProxy::OnPortDisconnected",
                               [actors = std::move(actors)]() {
                                 for (const auto& actor : actors) {
                                   actor->NotifyConnected();
                                 }
                               }));
  }
}

void SerialDeviceChangeProxy::OnPortDisconnected(const nsAString& aPortId) {
  RefPtr<SerialPlatformService> service = SerialPlatformService::GetInstance();
  if (!service) {
    return;
  }

  auto actors = ActorsById(aPortId);
  if (!actors.IsEmpty()) {
    service->IOThread()->Dispatch(
        NS_NewRunnableFunction("SerialDeviceChangeProxy::OnPortDisconnected",
                               [actors = std::move(actors)]() {
                                 for (const auto& actor : actors) {
                                   actor->NotifyDisconnected();
                                 }
                               }));
  }
}

NS_IMETHODIMP
SerialDeviceChangeProxy::Observe(nsISupports* aSubject, const char* aTopic,
                                 const char16_t* aData) {
  if (strcmp(aTopic, "serial-permission-revoked") == 0 && aSubject) {
    AssertIsOnMainThread();
    nsCOMPtr<BrowsingContext> revokedBC = do_QueryInterface(aSubject);
    if (!revokedBC) {
      return NS_OK;
    }
    uint64_t revokedBrowserId = revokedBC->GetBrowserId();

    if (mBrowserId != revokedBrowserId) {
      return NS_OK;
    }

    RevokeAllPorts();
  }
  return NS_OK;
}

SerialManagerParent::SerialManagerParent() { AssertIsOnMainThread(); }

SerialManagerParent::~SerialManagerParent() {
  AssertIsOnMainThread();
  MOZ_ASSERT(!mProxy, "Proxy should have been cleared");
}

void SerialManagerParent::Init(uint64_t aBrowserId) {
  AssertIsOnMainThread();
  MOZ_ASSERT(CanSend(), "Actor should have already been initialized");
  mBrowserId = aBrowserId;

  RefPtr<SerialPlatformService> platformService =
      SerialPlatformService::GetInstance();
  if (!platformService) {
    // If the SerialPlatformService is null, nothing is going to work
    // (and we don't try to create it again later)
    // We already log something in GetInstance(), so just exit here
    // after tearing down the newly created actor.
    (void)PSerialManagerParent::Send__delete__(this);
    return;
  }
  mProxy = MakeRefPtr<SerialDeviceChangeProxy>(mBrowserId);
  platformService->AddDeviceChangeObserver(mProxy);
  nsCOMPtr<nsIObserverService> obs = mozilla::services::GetObserverService();
  if (obs) {
    obs->AddObserver(mProxy, "serial-permission-revoked", false);
  }
}

mozilla::ipc::IPCResult SerialManagerParent::RecvGetAvailablePorts(
    GetAvailablePortsResolver&& aResolver) {
  AssertIsOnMainThread();
  RefPtr<SerialPlatformService> platformService =
      SerialPlatformService::GetInstance();
  if (!platformService) {
    aResolver(nsTArray<IPCSerialPortInfo>());
    return IPC_OK();
  }

  nsCOMPtr<nsISerialEventTarget> ioThread = platformService->IOThread();

  ioThread->Dispatch(NS_NewRunnableFunction(
      "SerialManagerParent::RecvGetAvailablePorts",
      [service = RefPtr{platformService},
       resolver = std::move(aResolver)]() mutable {
        SerialPortList result;
        if (NS_WARN_IF(NS_FAILED(service->EnumeratePorts(result)))) {
          result.Clear();
        }

        NS_DispatchToMainThread(NS_NewRunnableFunction(
            "SerialManagerParent::RecvGetAvailablePorts::Resolve",
            [result = std::move(result),
             resolver = std::move(resolver)]() mutable {
              resolver(std::move(result));
            }));
      }));

  return IPC_OK();
}

mozilla::ipc::IPCResult SerialManagerParent::RecvCreatePort(
    const nsString& aPortId,
    mozilla::ipc::Endpoint<PSerialPortParent>&& aEndpoint) {
  AssertIsOnMainThread();

  if (!aEndpoint.IsValid()) {
    return IPC_FAIL(this, "Invalid parent endpoint in RecvCreatePort");
  }
  RefPtr proxy = mProxy;
  if (!mProxy) {
    return IPC_OK();
  }

  // Bind the parent endpoint on the IO thread.
  RefPtr<SerialPlatformService> service = SerialPlatformService::GetInstance();
  if (service) {
    service->IOThread()->Dispatch(NS_NewRunnableFunction(
        "SerialPortParent::Bind",
        [portId = nsString(aPortId), browserId = mBrowserId,
         proxy = std::move(proxy), endpoint = std::move(aEndpoint)]() mutable {
          auto actor = MakeRefPtr<SerialPortParent>(portId, browserId, proxy);
          if (!endpoint.Bind(actor)) {
            MOZ_LOG(gWebSerialLog, LogLevel::Error,
                    ("SerialPortParent::Bind failed"));
            return;
          }
          proxy->AddPortActor(actor);
        }));
  }

  return IPC_OK();
}

template <typename TWork, typename TResolver>
mozilla::ipc::IPCResult SerialManagerParent::DispatchTestOperation(
    const char* aName, TWork&& aWork, TResolver&& aResolver) {
  AssertIsOnMainThread();
  if (!StaticPrefs::dom_webserial_testing_enabled()) {
    return IPC_FAIL(this, "Testing not enabled");
  }

  RefPtr<SerialPlatformService> platformService =
      SerialPlatformService::GetInstance();
  if (!platformService) {
    aResolver(NS_ERROR_FAILURE);
    return IPC_OK();
  }
  RefPtr<TestSerialPlatformService> testService =
      platformService->AsTestService();
  if (!testService) {
    aResolver(NS_ERROR_FAILURE);
    return IPC_OK();
  }

  platformService->IOThread()->Dispatch(
      NS_NewRunnableFunction(aName, [testService, aWork, aResolver]() {
        aWork(testService);
        NS_DispatchToMainThread(NS_NewRunnableFunction(
            "SerialManagerParent::DispatchTestOperation::Resolve",
            [aResolver]() { aResolver(NS_OK); }));
      }));

  return IPC_OK();
}

mozilla::ipc::IPCResult SerialManagerParent::RecvSimulateDeviceConnection(
    const nsString& aDeviceId, const nsString& aDevicePath, uint16_t aVendorId,
    uint16_t aProductId, SimulateDeviceConnectionResolver&& aResolver) {
  return DispatchTestOperation(
      "SerialManagerParent::SimulateDeviceConnection",
      [deviceId = nsString(aDeviceId), devicePath = nsString(aDevicePath),
       aVendorId, aProductId](TestSerialPlatformService* testService) {
        testService->SimulateDeviceConnection(deviceId, devicePath, aVendorId,
                                              aProductId);
      },
      std::move(aResolver));
}

mozilla::ipc::IPCResult SerialManagerParent::RecvSimulateDeviceDisconnection(
    const nsString& aDeviceId,
    SimulateDeviceDisconnectionResolver&& aResolver) {
  return DispatchTestOperation(
      "SerialManagerParent::SimulateDeviceDisconnection",
      [deviceId = nsString(aDeviceId)](TestSerialPlatformService* testService) {
        testService->SimulateDeviceDisconnection(deviceId);
      },
      std::move(aResolver));
}

mozilla::ipc::IPCResult SerialManagerParent::RecvRemoveAllMockDevices(
    RemoveAllMockDevicesResolver&& aResolver) {
  return DispatchTestOperation(
      "SerialManagerParent::RemoveAllMockDevices",
      [](TestSerialPlatformService* testService) {
        testService->RemoveAllMockDevices();
      },
      std::move(aResolver));
}

mozilla::ipc::IPCResult SerialManagerParent::RecvResetToDefaultMockDevices(
    ResetToDefaultMockDevicesResolver&& aResolver) {
  return DispatchTestOperation(
      "SerialManagerParent::ResetToDefaultMockDevices",
      [](TestSerialPlatformService* testService) {
        testService->ResetToDefaultMockDevices();
      },
      std::move(aResolver));
}

void SerialManagerParent::ActorDestroy(ActorDestroyReason aWhy) {
  AssertIsOnMainThread();

  RefPtr<SerialDeviceChangeProxy> proxy = mProxy.forget();
  if (proxy) {
    proxy->RevokeAllPorts();
    RefPtr<SerialPlatformService> platformService =
        SerialPlatformService::GetInstance();
    if (platformService) {
      platformService->RemoveDeviceChangeObserver(proxy);
    }

    nsCOMPtr<nsIObserverService> obs = mozilla::services::GetObserverService();
    if (obs) {
      obs->RemoveObserver(proxy, "serial-permission-revoked");
    }
  }
}

}  // namespace mozilla::dom
