/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/Serial.h"

#include "Navigator.h"
#include "SerialLogging.h"
#include "SerialPermissionRequest.h"
#include "mozilla/Preferences.h"
#include "mozilla/StaticPrefs_dom.h"
#include "mozilla/dom/BrowsingContext.h"
#include "mozilla/dom/Document.h"
#include "mozilla/dom/FeaturePolicyUtils.h"
#include "mozilla/dom/PSerialPort.h"
#include "mozilla/dom/Promise.h"
#include "mozilla/dom/SerialBinding.h"
#include "mozilla/dom/SerialManagerChild.h"
#include "mozilla/dom/SerialPort.h"
#include "mozilla/dom/SerialPortChild.h"
#include "mozilla/dom/WindowContext.h"
#include "mozilla/dom/WindowGlobalChild.h"
#include "mozilla/dom/WorkerCommon.h"
#include "mozilla/dom/WorkerPrivate.h"
#include "mozilla/dom/WorkerRef.h"
#include "nsContentUtils.h"
#include "nsPIDOMWindow.h"
#include "nsThreadUtils.h"

namespace mozilla::dom {

static Serial* FindWindowSerialForWorkerPrivate(WorkerPrivate* aWorkerPrivate) {
  AssertIsOnMainThread();
  MOZ_ASSERT(aWorkerPrivate);
  nsPIDOMWindowInner* inner = aWorkerPrivate->GetAncestorWindow();
  if (!inner) {
    return nullptr;
  }
  return inner->Navigator()->GetExistingSerial();
}

NS_IMPL_CYCLE_COLLECTION_WEAK_PTR_INHERITED(Serial, DOMEventTargetHelper,
                                            mPorts)

NS_IMPL_ADDREF_INHERITED(Serial, DOMEventTargetHelper)
NS_IMPL_RELEASE_INHERITED(Serial, DOMEventTargetHelper)

NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(Serial)
NS_INTERFACE_MAP_END_INHERITING(DOMEventTargetHelper)

LazyLogModule gWebSerialLog("WebSerial");

Serial::Serial(nsPIDOMWindowInner* aWindow) : DOMEventTargetHelper(aWindow) {
  MOZ_LOG(gWebSerialLog, LogLevel::Debug,
          ("Serial[%p] created for window", this));
  AssertIsOnMainThread();
}

Serial::Serial(nsIGlobalObject* aGlobal) : DOMEventTargetHelper(aGlobal) {
  MOZ_LOG(gWebSerialLog, LogLevel::Debug,
          ("Serial[%p] created for global", this));
  MOZ_ASSERT(!NS_IsMainThread());
}

Serial::~Serial() {
  MOZ_LOG(gWebSerialLog, LogLevel::Debug, ("Serial[%p] destroyed", this));
  MOZ_ASSERT(mHasShutdown);
}

void Serial::Shutdown() {
  if (mHasShutdown) {
    return;
  }
  MOZ_LOG(gWebSerialLog, LogLevel::Debug, ("Serial[%p] shutting down", this));
  mHasShutdown = true;
  mManagerChild = nullptr;
  for (const auto& port : mPorts) {
    port->Shutdown();
  }
  mPorts.Clear();
}

void Serial::DisconnectFromOwner() {
  Shutdown();
  DOMEventTargetHelper::DisconnectFromOwner();
}

JSObject* Serial::WrapObject(JSContext* aCx,
                             JS::Handle<JSObject*> aGivenProto) {
  return Serial_Binding::Wrap(aCx, this, aGivenProto);
}

SerialManagerChild* Serial::GetOrCreateManagerChild() {
  if (mManagerChild) {
    return mManagerChild;
  }

  AssertIsOnMainThread();

  nsPIDOMWindowInner* window = GetOwnerWindow();
  if (!window) {
    return nullptr;
  }

  WindowGlobalChild* wgc = window->GetWindowGlobalChild();
  if (!wgc) {
    return nullptr;
  }

  auto child = MakeRefPtr<SerialManagerChild>(this);
  if (!wgc->SendPSerialManagerConstructor(child)) {
    return nullptr;
  }

  mManagerChild = child;
  return mManagerChild;
}

// Returns whether the security check was passed. If this method returns
// false, the promise has been rejected.
static bool PortSecurityCheck(Promise& aPromise, nsIGlobalObject* aGlobal,
                              const nsCString& aFunctionName) {
  if (nsPIDOMWindowInner* window = aGlobal->GetAsInnerWindow()) {
    Document* doc = window->GetExtantDoc();
    if (!doc) {
      aPromise.MaybeRejectWithSecurityError(
          aFunctionName + "() is not allowed without a document"_ns);
      return false;
    }

    // web-platform-tests seem to indicate this is necessary, but the spec does
    // not. spec issue: https://github.com/WICG/serial/issues/223
    if (doc->NodePrincipal()->GetIsNullPrincipal()) {
      aPromise.MaybeRejectWithSecurityError(
          aFunctionName + "() is not allowed for opaque origins"_ns);
      return false;
    }

    if (!FeaturePolicyUtils::IsFeatureAllowed(doc, u"serial"_ns)) {
      nsAutoString message;
      message.AssignLiteral("WebSerial access request was denied: ");
      message.Append(NS_ConvertUTF8toUTF16(aFunctionName));
      message.AppendLiteral("() is not allowed in this context");
      nsContentUtils::ReportToConsoleNonLocalized(
          message, nsIScriptError::errorFlag, "Security"_ns, doc);
      aPromise.MaybeRejectWithSecurityError(
          aFunctionName + "() is not allowed in this context"_ns);
      return false;
    }
    return true;
  }
  WorkerPrivate* workerPrivate = GetCurrentThreadWorkerPrivate();
  if (!workerPrivate) {
    aPromise.MaybeRejectWithSecurityError(
        aFunctionName + "() is not allowed without a window or worker"_ns);
    return false;
  }
  if (!workerPrivate->SerialAllowed()) {
    aPromise.MaybeRejectWithSecurityError(
        aFunctionName + "() is not allowed in this context"_ns);
    return false;
  }
  return true;
}

// Returns whether the filters validated successfully. If this function
// returns false, aPromise will have been resolved with an error.
static bool ValidatePortFilters(const Sequence<SerialPortFilter>& aFilters,
                                dom::Promise& aPromise) {
  for (const auto& filter : aFilters) {
    // https://wicg.github.io/serial/#ref-for-dom-serialportrequestoptions-filters-1
    if (filter.mBluetoothServiceClassId.WasPassed()) {
      if (filter.mUsbVendorId.WasPassed() || filter.mUsbProductId.WasPassed()) {
        aPromise.MaybeRejectWithTypeError(
            "A filter cannot specify both bluetoothServiceClassId and "
            "usbVendorId or usbProductId.");
        return false;
      }
    } else {
      if (!filter.mUsbVendorId.WasPassed()) {
        if (!filter.mUsbProductId.WasPassed()) {
          aPromise.MaybeRejectWithTypeError(
              "A filter must provide a property to filter by.");
        } else {
          aPromise.MaybeRejectWithTypeError(
              "A filter containing a usbProductId must also specify a "
              "usbVendorId.");
        }
        return false;
      }
    }
  }
  return true;
}

already_AddRefed<Promise> Serial::RequestPort(
    const SerialPortRequestOptions& aOptions, ErrorResult& aRv) {
  AssertIsOnMainThread();
  // RequestPort() doesn't work in workers, so we can skip straight
  // to the window.
  nsPIDOMWindowInner* window = GetOwnerWindow();
  if (!window) {
    MOZ_LOG(gWebSerialLog, LogLevel::Error,
            ("Serial[%p]::RequestPort failed: no window available", this));
    return nullptr;
  }

  // https://wicg.github.io/serial/#dom-serial-requestport
  // Step 1: Let promise be a new promise.
  RefPtr<Promise> promise = Promise::Create(window->AsGlobal(), aRv);
  if (NS_WARN_IF(aRv.Failed())) {
    return nullptr;
  }

  MOZ_LOG(
      gWebSerialLog, LogLevel::Info,
      ("Serial[%p]::RequestPort called (filters: %s, allowedBluetoothUUIDs: "
       "%s)",
       this, aOptions.mFilters.WasPassed() ? "provided" : "none",
       aOptions.mAllowedBluetoothServiceClassIds.WasPassed() ? "provided"
                                                             : "none"));

  // Step 2: If this's relevant global object's associated Document is not
  // allowed to use the "serial" feature, reject with a SecurityError.
  if (!PortSecurityCheck(*promise, window->AsGlobal(), "requestPort"_ns)) {
    MOZ_LOG(gWebSerialLog, LogLevel::Warning,
            ("Serial[%p]::RequestPort failed security check", this));
    return promise.forget();
  }

  // Step 3: If the relevant global object does not have transient activation,
  // reject with a SecurityError.
  WindowContext* context = window->GetWindowContext();
  if (!context) {
    MOZ_LOG(
        gWebSerialLog, LogLevel::Error,
        ("Serial[%p]::RequestPort failed: no window context available", this));
    promise->MaybeRejectWithNotSupportedError("No window context available");
    return promise.forget();
  }
  if (!context->HasValidTransientUserGestureActivation()) {
    MOZ_LOG(gWebSerialLog, LogLevel::Warning,
            ("Serial[%p]::RequestPort failed: no user activation", this));
    promise->MaybeRejectWithSecurityError(
        "requestPort() requires user activation");
    return promise.forget();
  }

  // Step 4: If options["filters"] is present, validate each filter.
  if (aOptions.mFilters.WasPassed()) {
    MOZ_LOG(gWebSerialLog, LogLevel::Debug,
            ("Serial[%p]::RequestPort validating %zu filters", this,
             aOptions.mFilters.Value().Length()));
    if (!ValidatePortFilters(aOptions.mFilters.Value(), *promise)) {
      MOZ_LOG(gWebSerialLog, LogLevel::Warning,
              ("Serial[%p]::RequestPort failed filter validation", this));
      return promise.forget();
    }
  }

  // In testing mode with auto-select, directly create a port from
  // TestSerialPlatformService without showing the chooser UI.
  // However, when gated mode is enabled, we must go through the full
  // SerialPermissionRequest flow to test the addon installation path.
  if (StaticPrefs::dom_webserial_testing_enabled() && mAutoselectPorts &&
      !StaticPrefs::dom_webserial_gated()) {
    return RequestPortWithTestingAutoselect(aOptions, std::move(promise));
  }

  // Step 5 (in parallel): Enumerate available ports, prompt the user to select
  // one, and resolve or reject the promise accordingly.
  MOZ_LOG(gWebSerialLog, LogLevel::Info,
          ("Serial[%p]::RequestPort starting permission request", this));
  auto request =
      MakeRefPtr<SerialPermissionRequest>(window, promise, aOptions, this);

  nsresult rv = request->Run();
  if (NS_WARN_IF(NS_FAILED(rv))) {
    MOZ_LOG(
        gWebSerialLog, LogLevel::Error,
        ("Serial[%p]::RequestPort failed to start permission request: 0x%08x",
         this, static_cast<uint32_t>(rv)));
    promise->MaybeRejectWithNotSupportedError(
        "Failed to start permission request");
    return promise.forget();
  }

  // Step 6: Return promise.
  return promise.forget();
}

already_AddRefed<Promise> Serial::RequestPortWithTestingAutoselect(
    const SerialPortRequestOptions& aOptions, RefPtr<Promise> aPromise) {
  // In testing mode with auto-select, directly create a port from
  // TestSerialPlatformService without showing the chooser UI
  AssertIsOnMainThread();
  MOZ_RELEASE_ASSERT(StaticPrefs::dom_webserial_testing_enabled());
  MOZ_RELEASE_ASSERT(!StaticPrefs::dom_webserial_gated());

  MOZ_LOG(gWebSerialLog, LogLevel::Info,
          ("Serial[%p]::RequestPort using testing mode autoselect", this));

  SerialManagerChild* child = GetOrCreateManagerChild();
  if (!child) {
    MOZ_LOG(gWebSerialLog, LogLevel::Error,
            ("Serial[%p]::RequestPort failed: IPC manager child not available",
             this));
    aPromise->MaybeRejectWithNotSupportedError("IPC not available");
    return aPromise.forget();
  }

  Sequence<SerialPortFilter> filters;
  if (aOptions.mFilters.WasPassed()) {
    if (!filters.AppendElements(aOptions.mFilters.Value(), mozilla::fallible)) {
      MOZ_LOG(gWebSerialLog, LogLevel::Error,
              ("Serial[%p]::RequestPort failed to copy filter options", this));
      aPromise->MaybeRejectWithNotSupportedError(
          "Failed to copy filter options");
      return aPromise.forget();
    }
  }

  MOZ_LOG(
      gWebSerialLog, LogLevel::Debug,
      ("Serial[%p]::RequestPort sending GetAvailablePorts IPC request", this));
  // In the second lambda below, we only need "this" to log the pointer value.
  // So declare selfPtr as void* to ensure we don't try to use it (without
  // wrapping it in a RefPtr).
  void* selfPtr = this;
  child->SendGetAvailablePorts()->Then(
      GetMainThreadSerialEventTarget(), __func__,
      [promise = aPromise, self = RefPtr{this},
       filters = std::move(filters)](nsTArray<IPCSerialPortInfo>&& ports) {
        MOZ_LOG(gWebSerialLog, LogLevel::Debug,
                ("Serial[%p]::RequestPort received %zu ports", self.get(),
                 ports.Length()));
        if (!ApplyPortFilters(ports, filters)) {
          MOZ_LOG(
              gWebSerialLog, LogLevel::Warning,
              ("Serial[%p]::RequestPort failed applying filters", self.get()));
          promise->MaybeRejectWithTypeError(
              "Invalid bluetoothServiceClassId in port filter");
          return;
        }

        if (ports.IsEmpty()) {
          MOZ_LOG(gWebSerialLog, LogLevel::Warning,
                  ("Serial[%p]::RequestPort no serial port available after "
                   "filtering",
                   self.get()));
          promise->MaybeRejectWithNotFoundError("No serial port available");
          return;
        }

        MOZ_LOG(gWebSerialLog, LogLevel::Info,
                ("Serial[%p]::RequestPort selected port '%s' (testing mode)",
                 self.get(), NS_ConvertUTF16toUTF8(ports[0].id()).get()));

        RefPtr<SerialPort> port = self->GetOrCreatePort(ports[0]);
        if (!port) {
          promise->MaybeRejectWithNotSupportedError(
              "Failed to create port actor");
          return;
        }
        port->MarkPhysicallyPresent();
        promise->MaybeResolve(port);
      },
      [promise = aPromise,
       selfPtr](mozilla::ipc::ResponseRejectReason aReason) {
        MOZ_LOG(gWebSerialLog, LogLevel::Error,
                ("Serial[%p]::RequestPort IPC request failed (reason: %d)",
                 selfPtr, (int)aReason));
        promise->MaybeRejectWithNotSupportedError("IPC request failed");
      });

  return aPromise.forget();
}

already_AddRefed<Promise> Serial::GetPorts(ErrorResult& aRv) {
  nsIGlobalObject* global = GetOwnerGlobal();
  if (!global) {
    aRv.ThrowInvalidStateError("No global object available");
    return nullptr;
  }

  // https://wicg.github.io/serial/#dom-serial-getports
  // Step 1: Let promise be a new promise.
  RefPtr<Promise> promise = Promise::Create(global, aRv);
  if (NS_WARN_IF(aRv.Failed())) {
    return nullptr;
  }

  MOZ_LOG(gWebSerialLog, LogLevel::Debug,
          ("Serial[%p]::GetPorts called", this));

  // Step 2: If this's relevant global object's associated Document is not
  // allowed to use the "serial" feature, reject with a SecurityError.
  if (!PortSecurityCheck(*promise, global, "getPorts"_ns)) {
    MOZ_LOG(gWebSerialLog, LogLevel::Warning,
            ("Serial[%p]::GetPorts failed security check", this));
    return promise.forget();
  }

  // Step 3 (in parallel): Get the sequence of available serial ports the user
  // has granted access to, then queue a task to resolve the promise.
  if (NS_IsMainThread()) {
    nsTArray<RefPtr<SerialPort>> result;
    for (const auto& port : mPorts) {
      if (!port->IsForgotten() && port->PhysicallyPresent()) {
        result.AppendElement(port);
      }
    }

    MOZ_LOG(
        gWebSerialLog, LogLevel::Info,
        ("Serial[%p]::GetPorts returning %zu ports", this, result.Length()));

    // Queue a task to resolve the promise per spec step 3.3
    NS_DispatchToCurrentThread(NS_NewRunnableFunction(
        "Serial::GetPorts resolve",
        [promise = RefPtr{promise}, result = std::move(result)]() mutable {
          promise->MaybeResolve(result);
        }));

    // Step 4: Return promise.
    return promise.forget();
  }

  // Worker path: collect known port IDs, dispatch to main thread to get
  // new grants and clone their actors, then dispatch back to create
  // SerialPort objects for any new ports.
  MOZ_LOG(gWebSerialLog, LogLevel::Debug,
          ("Serial[%p]::GetPorts called from worker, dispatching to main "
           "thread",
           this));

  WorkerPrivate* workerPrivate = GetCurrentThreadWorkerPrivate();
  if (!workerPrivate) {
    MOZ_LOG(gWebSerialLog, LogLevel::Error,
            ("Serial[%p]::GetPorts failed: no worker private", this));
    promise->MaybeRejectWithNotSupportedError("Worker context not available");
    return promise.forget();
  }

  nsTArray<nsString> knownPortIds;
  for (const auto& port : mPorts) {
    knownPortIds.AppendElement(port->Id());
  }

  RefPtr<StrongWorkerRef> strongRef =
      StrongWorkerRef::Create(workerPrivate, "Serial::GetPorts");
  if (!strongRef) {
    promise->MaybeRejectWithAbortError("Worker is shutting down");
    return promise.forget();
  }

  auto tsRef = MakeRefPtr<ThreadSafeWorkerRef>(strongRef);

  struct NewPortData {
    IPCSerialPortInfo mInfo;
    mozilla::ipc::Endpoint<PSerialPortChild> mEndpoint;
  };
  struct GetPortsData {
    nsTArray<NewPortData> mNewPorts;
    nsTArray<nsString> mIdsToForget;
  };
  using GetPortsPromise = MozPromise<GetPortsData, nsresult, true>;

  // InvokeAsync dispatches the lambda to the main thread and returns a
  // MozPromise. No non-threadsafe RefPtrs cross thread boundaries.
  InvokeAsync(
      GetMainThreadSerialEventTarget(), __func__,
      [tsRef, knownPortIds = std::move(knownPortIds)]() {
        Serial* windowSerial =
            FindWindowSerialForWorkerPrivate(tsRef->Private());

        GetPortsData getPortsData;
        if (windowSerial) {
          for (const auto& port : windowSerial->mPorts) {
            if (port->IsForgotten()) {
              continue;
            }

            bool alreadyKnown = false;
            for (const auto& id : knownPortIds) {
              if (id == port->Id()) {
                alreadyKnown = true;
                break;
              }
            }
            if (alreadyKnown) {
              continue;
            }

            RefPtr<SerialPortChild> child = port->GetChild();
            if (!child || !child->CanSend()) {
              continue;
            }

            mozilla::ipc::Endpoint<PSerialPortParent> parentEp;
            mozilla::ipc::Endpoint<PSerialPortChild> childEp;
            if (NS_FAILED(PSerialPort::CreateEndpoints(&parentEp, &childEp))) {
              continue;
            }

            child->SendClone(std::move(parentEp));

            NewPortData data;
            data.mInfo = port->GetPortInfo();
            data.mEndpoint = std::move(childEp);
            getPortsData.mNewPorts.AppendElement(std::move(data));
          }

          // Determine which ports the worker knows about that have been
          // forgotten or removed on the main thread.
          for (const auto& id : knownPortIds) {
            bool stillActive = false;
            for (const auto& port : windowSerial->mPorts) {
              if (!port->IsForgotten() && port->Id() == id) {
                stillActive = true;
                break;
              }
            }
            if (!stillActive) {
              getPortsData.mIdsToForget.AppendElement(id);
            }
          }
        } else {
          // Window Serial is gone; forget all known ports.
          getPortsData.mIdsToForget = knownPortIds.Clone();
        }

        return GetPortsPromise::CreateAndResolve(std::move(getPortsData),
                                                 __func__);
      })
      ->Then(
          GetCurrentSerialEventTarget(), __func__,
          // Capture tsRef here to avoid a race with the worker losing the
          // workerref.
          [self = RefPtr{this}, tsRef, promise](GetPortsData&& aData) {
            for (auto& data : aData.mNewPorts) {
              RefPtr<SerialPort> port =
                  MakeRefPtr<SerialPort>(data.mInfo, self);
              auto actor = MakeRefPtr<SerialPortChild>();
              if (data.mEndpoint.Bind(actor)) {
                actor->SetPort(port);
                port->SetChild(actor);
              }
              self->mPorts.AppendElement(std::move(port));
            }

            for (const auto& id : aData.mIdsToForget) {
              self->ForgetPort(id);
            }

            nsTArray<RefPtr<SerialPort>> result;
            for (const auto& port : self->mPorts) {
              if (!port->IsForgotten() && port->PhysicallyPresent()) {
                result.AppendElement(port);
              }
            }
            promise->MaybeResolve(result);
          },
          [promise](nsresult aRv) {
            promise->MaybeRejectWithNotSupportedError(
                "Failed to get ports from main thread");
          });

  return promise.forget();
}

// https://webbluetoothcg.github.io/web-bluetooth/#dom-bluetoothuuid-canonicaluuid
// Replaces the top 32 bits of 00000000-0000-1000-8000-00805f9b34fb with the
// alias. E.g. canonicalUUID(0xDEADBEEF) =>
// "deadbeef-0000-1000-8000-00805f9b34fb"
static nsAutoString BluetoothCanonicalUUID(uint32_t aAlias) {
  nsAutoString result;
  result.AppendPrintf("%08x-0000-1000-8000-00805f9b34fb", aAlias);
  return result;
}

// A valid UUID is a lowercase string matching
// /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// https://webbluetoothcg.github.io/web-bluetooth/#valid-uuid
static bool IsValidBluetoothUUID(const nsAString& aString) {
  // 8-4-4-4-12 = 32 hex chars + 4 dashes = 36 chars
  if (aString.Length() != 36) {
    return false;
  }
  const char16_t* data = aString.BeginReading();
  for (uint32_t i = 0; i < 36; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (data[i] != '-') {
        return false;
      }
    } else if (!((data[i] >= '0' && data[i] <= '9') ||
                 (data[i] >= 'a' && data[i] <= 'f'))) {
      return false;
    }
  }
  return true;
}

// Implements ResolveUUIDName(name, GATT assigned services) from the
// Web Bluetooth spec, used by BluetoothUUID.getService().
// https://webbluetoothcg.github.io/web-bluetooth/#resolveuuidname
// Returns true on success and sets aResult; returns false on error (step 4).
static bool ResolveBluetoothServiceUUID(const OwningStringOrUnsignedLong& aName,
                                        nsAutoString& aResult) {
  // Step 1: If name is an unsigned long, return canonicalUUID(name).
  if (aName.IsUnsignedLong()) {
    aResult = BluetoothCanonicalUUID(aName.GetAsUnsignedLong());
    return true;
  }

  const nsString& name = aName.GetAsString();

  // Step 2: If name is a valid UUID, return name.
  if (IsValidBluetoothUUID(name)) {
    aResult = name;
    return true;
  }

  // Step 3: If name is a valid name and maps to a UUID in GATT assigned
  // services, return canonicalUUID(alias).
  // We do not currently support GATT assigned service name lookup (bug 2013908)

  // Step 4: Otherwise, throw a TypeError.
  return false;
}

// https://wicg.github.io/serial/#dfn-matches-the-filter
// A port matches a filter if for each present member of the filter,
// the port has a matching value.
bool Serial::ApplyPortFilters(nsTArray<IPCSerialPortInfo>& aPorts,
                              const Sequence<SerialPortFilter>& aFilters) {
  if (aFilters.IsEmpty()) {
    return true;
  }

  bool filtersValid = true;
  aPorts.RemoveElementsBy([&](const IPCSerialPortInfo& port) {
    if (!filtersValid) {
      // We have already resolved the promise with a TypeError,
      // just early exit
      return false;
    }
    for (const auto& filter : aFilters) {
      // Step 1: If filter.usbVendorId is present and port's USB vendor ID
      // does not match, this filter fails.
      bool vendorMatches =
          !filter.mUsbVendorId.WasPassed() ||
          (port.usbVendorId() &&
           port.usbVendorId().value() == filter.mUsbVendorId.Value());

      // Step 2: If filter.usbProductId is present and port's USB product ID
      // does not match, this filter fails.
      bool productMatches =
          !filter.mUsbProductId.WasPassed() ||
          (port.usbProductId() &&
           port.usbProductId().value() == filter.mUsbProductId.Value());

      // Step 3: If filter.bluetoothServiceClassId is present and port's
      // Bluetooth service class ID does not match, this filter fails.
      bool bluetoothMatches = true;
      if (filter.mBluetoothServiceClassId.WasPassed()) {
        nsAutoString filterUUID;
        if (!ResolveBluetoothServiceUUID(
                filter.mBluetoothServiceClassId.Value(), filterUUID)) {
          // Resolution failed (invalid name per ResolveUUIDName step 4)
          filtersValid = false;
          return false;
        } else if (port.bluetoothServiceClassId().isNothing()) {
          bluetoothMatches = false;
        } else {
          bluetoothMatches =
              port.bluetoothServiceClassId().value() == filterUUID;
        }
      }

      // Step 4: The port matches if all present filter members matched.
      if (vendorMatches && productMatches && bluetoothMatches) {
        return false;
      }
    }
    return true;
  });
  return filtersValid;
}

void Serial::ForgetAllPorts() {
  if (mHasShutdown) {
    return;
  }

  nsTArray<RefPtr<SerialPort>> portsToForget;
  for (const auto& port : mPorts) {
    if (!port->IsForgotten()) {
      portsToForget.AppendElement(port);
    }
  }

  MOZ_LOG(gWebSerialLog, LogLevel::Info,
          ("Serial[%p]::ForgetAllPorts forgetting %zu ports", this,
           portsToForget.Length()));

  for (const RefPtr<SerialPort>& port : portsToForget) {
    RefPtr<SerialPort> strongPort = port;
    IgnoredErrorResult rv;
    RefPtr<Promise> promise = strongPort->Forget(rv);
  }
}

RefPtr<SerialPort> Serial::GetOrCreatePort(const IPCSerialPortInfo& aInfo) {
  // Look for an existing port with the same ID.
  for (const auto& existing : mPorts) {
    if (existing->Id() == aInfo.id() && !existing->IsForgotten()) {
      return existing;
    }
  }

  RefPtr<SerialPort> port = MakeRefPtr<SerialPort>(aInfo, this);

  // On the main thread, eagerly create and bind a PSerialPort actor.
  if (NS_IsMainThread()) {
    SerialManagerChild* child = GetOrCreateManagerChild();
    if (child) {
      RefPtr<SerialPortChild> actor = child->CreatePort(aInfo.id());
      if (actor) {
        actor->SetPort(port);
        port->SetChild(actor);
      }
    }
  }

  mPorts.AppendElement(port);
  return port;
}

void Serial::ForgetPort(const nsAString& aPortId) {
  for (const auto& port : mPorts) {
    if (port->Id() == aPortId && !port->IsForgotten()) {
      RefPtr<SerialPort> strongPort(port);
      strongPort->MarkForgotten();
    }
  }
  mPorts.RemoveElementsBy([&aPortId](const RefPtr<SerialPort>& port) {
    return port->Id() == aPortId;
  });

  // If on a worker, also remove from the main thread's Serial.
  if (!NS_IsMainThread()) {
    WorkerPrivate* workerPrivate = GetCurrentThreadWorkerPrivate();
    if (workerPrivate) {
      RefPtr<StrongWorkerRef> strongRef =
          StrongWorkerRef::Create(workerPrivate, "Serial::ForgetPort");
      if (strongRef) {
        auto tsRef = MakeRefPtr<ThreadSafeWorkerRef>(strongRef);
        nsString portId(aPortId);
        NS_DispatchToMainThread(NS_NewRunnableFunction(
            "Serial::ForgetPort cross-context",
            [tsRef = std::move(tsRef), portId]() {
              RefPtr<Serial> windowSerial =
                  FindWindowSerialForWorkerPrivate(tsRef->Private());
              if (windowSerial) {
                windowSerial->ForgetPort(portId);
              }
            }));
      }
    }
  }
}

SerialManagerChild* Serial::GetManagerChildForTesting(ErrorResult& aRv) {
  if (!StaticPrefs::dom_webserial_testing_enabled()) {
    aRv.ThrowNotSupportedError("Testing is not enabled");
    return nullptr;
  }
  SerialManagerChild* child = GetOrCreateManagerChild();
  if (!child) {
    aRv.ThrowNotSupportedError("IPC manager child not available");
    return nullptr;
  }
  return child;
}

already_AddRefed<Promise> Serial::SimulateDeviceConnection(
    const nsAString& aDeviceId, const nsAString& aDevicePath,
    uint16_t aVendorId, uint16_t aProductId, ErrorResult& aRv) {
  SerialManagerChild* child = GetManagerChildForTesting(aRv);
  if (!child) {
    return nullptr;
  }

  nsIGlobalObject* global = GetOwnerGlobal();
  if (!global) {
    aRv.Throw(NS_ERROR_FAILURE);
    return nullptr;
  }

  RefPtr<Promise> promise = Promise::Create(global, aRv);
  if (aRv.Failed()) {
    return nullptr;
  }

  child
      ->SendSimulateDeviceConnection(nsString(aDeviceId), nsString(aDevicePath),
                                     aVendorId, aProductId)
      ->Then(
          GetCurrentSerialEventTarget(), __func__,
          [promise](nsresult) { promise->MaybeResolveWithUndefined(); },
          [promise](mozilla::ipc::ResponseRejectReason) {
            promise->MaybeRejectWithAbortError(
                "SimulateDeviceConnection IPC error");
          });

  return promise.forget();
}

already_AddRefed<Promise> Serial::SimulateDeviceDisconnection(
    const nsAString& aDeviceId, ErrorResult& aRv) {
  SerialManagerChild* child = GetManagerChildForTesting(aRv);
  if (!child) {
    return nullptr;
  }

  nsIGlobalObject* global = GetOwnerGlobal();
  if (!global) {
    aRv.Throw(NS_ERROR_FAILURE);
    return nullptr;
  }

  RefPtr<Promise> promise = Promise::Create(global, aRv);
  if (aRv.Failed()) {
    return nullptr;
  }

  child->SendSimulateDeviceDisconnection(nsString(aDeviceId))
      ->Then(
          GetCurrentSerialEventTarget(), __func__,
          [promise](nsresult) { promise->MaybeResolveWithUndefined(); },
          [promise](mozilla::ipc::ResponseRejectReason) {
            promise->MaybeRejectWithAbortError(
                "SimulateDeviceDisconnection IPC error");
          });

  return promise.forget();
}

already_AddRefed<Promise> Serial::RemoveAllMockDevices(ErrorResult& aRv) {
  SerialManagerChild* child = GetManagerChildForTesting(aRv);
  if (!child) {
    return nullptr;
  }

  nsIGlobalObject* global = GetOwnerGlobal();
  if (!global) {
    aRv.Throw(NS_ERROR_FAILURE);
    return nullptr;
  }

  RefPtr<Promise> promise = Promise::Create(global, aRv);
  if (aRv.Failed()) {
    return nullptr;
  }

  child->SendRemoveAllMockDevices()->Then(
      GetCurrentSerialEventTarget(), __func__,
      [promise](nsresult) { promise->MaybeResolveWithUndefined(); },
      [promise](mozilla::ipc::ResponseRejectReason) {
        promise->MaybeRejectWithAbortError("RemoveAllMockDevices IPC error");
      });

  return promise.forget();
}

already_AddRefed<Promise> Serial::ResetToDefaultMockDevices(ErrorResult& aRv) {
  SerialManagerChild* child = GetManagerChildForTesting(aRv);
  if (!child) {
    return nullptr;
  }

  nsIGlobalObject* global = GetOwnerGlobal();
  if (!global) {
    aRv.Throw(NS_ERROR_FAILURE);
    return nullptr;
  }

  RefPtr<Promise> promise = Promise::Create(global, aRv);
  if (aRv.Failed()) {
    return nullptr;
  }

  child->SendResetToDefaultMockDevices()->Then(
      GetCurrentSerialEventTarget(), __func__,
      [promise](nsresult) { promise->MaybeResolveWithUndefined(); },
      [promise](mozilla::ipc::ResponseRejectReason) {
        promise->MaybeRejectWithAbortError(
            "ResetToDefaultMockDevices IPC error");
      });

  return promise.forget();
}

bool Serial::GetAutoselectPorts(ErrorResult& aRv) const {
  if (!StaticPrefs::dom_webserial_testing_enabled()) {
    aRv.ThrowNotSupportedError("Testing is not enabled");
    return false;
  }
  return mAutoselectPorts;
}

void Serial::SetAutoselectPorts(bool aAutoselect, ErrorResult& aRv) {
  if (!StaticPrefs::dom_webserial_testing_enabled()) {
    aRv.ThrowNotSupportedError("Testing is not enabled");
    return;
  }
  mAutoselectPorts = aAutoselect;
}

}  // namespace mozilla::dom
