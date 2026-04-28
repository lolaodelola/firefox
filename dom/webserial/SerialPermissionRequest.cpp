/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "SerialPermissionRequest.h"

#include "SerialLogging.h"
#include "mozilla/BasePrincipal.h"
#include "mozilla/JSONStringWriteFuncs.h"
#include "mozilla/JSONWriter.h"
#include "mozilla/RandomNum.h"
#include "mozilla/StaticPrefs_dom.h"
#include "mozilla/dom/Document.h"
#include "mozilla/dom/Promise.h"
#include "mozilla/dom/ScriptSettings.h"
#include "mozilla/dom/Serial.h"
#include "mozilla/dom/SerialManagerChild.h"
#include "mozilla/dom/SerialPort.h"
#include "nsContentUtils.h"
#include "nsThreadUtils.h"

namespace mozilla::dom {

constexpr uint32_t kPermissionDeniedBaseDelayMs = 3000;
constexpr uint32_t kPermissionDeniedMaxRandomDelayMs = 10000;

NS_IMPL_CYCLE_COLLECTION_INHERITED(SerialPermissionRequest,
                                   ContentPermissionRequestBase, mPromise,
                                   mSerial)

NS_IMPL_ISUPPORTS_CYCLE_COLLECTION_INHERITED(SerialPermissionRequest,
                                             ContentPermissionRequestBase,
                                             nsIRunnable)

SerialPermissionRequest::SerialPermissionRequest(
    nsPIDOMWindowInner* aWindow, Promise* aPromise,
    const SerialPortRequestOptions& aOptions, Serial* aSerial)
    : ContentPermissionRequestBase(aWindow->GetDoc()->NodePrincipal(), aWindow,
                                   ""_ns, "serial"_ns),
      mPromise(aPromise),
      mOptions(aOptions),
      mSerial(aSerial) {
  MOZ_ASSERT(aPromise);
  MOZ_ASSERT(aSerial);
  mPrincipal = aWindow->GetDoc()->NodePrincipal();
  MOZ_ASSERT(mPrincipal);
}

NS_IMETHODIMP
SerialPermissionRequest::GetTypes(nsIArray** aTypes) {
  NS_ENSURE_ARG_POINTER(aTypes);

  MOZ_LOG(gWebSerialLog, LogLevel::Info,
          ("SerialPermissionRequest::GetTypes called with %zu ports",
           mAvailablePorts.Length()));

  nsTArray<nsString> options;

  // Pass autoselect flag to the UI via options metadata
  if (ShouldAutoselect()) {
    options.AppendElement(u"{\"__autoselect__\":true}"_ns);
  }

  size_t index = 0;
  for (const auto& port : mAvailablePorts) {
    nsCString utf8Json;
    JSONStringRefWriteFunc writeFunc(utf8Json);
    JSONWriter writer(writeFunc, JSONWriter::SingleLineStyle);

    NS_ConvertUTF16toUTF8 utf8Path(port.path());
    NS_ConvertUTF16toUTF8 utf8FriendlyName(port.friendlyName());

    MOZ_LOG(gWebSerialLog, LogLevel::Debug,
            ("  Port[%zu]: path=%s, friendlyName=%s, vid=0x%04x, pid=0x%04x",
             index, utf8Path.get(), utf8FriendlyName.get(),
             port.usbVendorId().valueOr(0), port.usbProductId().valueOr(0)));

    writer.StartObjectElement();
    writer.StringProperty("path", MakeStringSpan(utf8Path.get()));
    writer.StringProperty("friendlyName",
                          MakeStringSpan(utf8FriendlyName.get()));
    writer.IntProperty("usbVendorId", port.usbVendorId().valueOr(0));
    writer.IntProperty("usbProductId", port.usbProductId().valueOr(0));
    writer.EndObject();

    nsString utf16Json;
    CopyUTF8toUTF16(utf8Json, utf16Json);
    options.AppendElement(std::move(utf16Json));
    index++;
  }

  return nsContentPermissionUtils::CreatePermissionArray(mType, options,
                                                         aTypes);
}

NS_IMETHODIMP
SerialPermissionRequest::Cancel() {
  mCancelTimer = nullptr;

  // loopback hosts and file:/// URLs do not require the addon
  if (StaticPrefs::dom_webserial_gated() &&
      StaticPrefs::dom_sitepermsaddon_provider_enabled() &&
      mCancellationReason == CancellationReason::UserCancelled &&
      !IsSitePermAllow() && !mPrincipal->GetIsLoopbackHost() &&
      !mPrincipal->SchemeIs("file")) {
    mCancellationReason = CancellationReason::AddonDenied;
  }

  switch (mCancellationReason) {
    case CancellationReason::UserCancelled:
      mPromise->MaybeRejectWithNotFoundError("No port selected");
      break;
    case CancellationReason::AddonDenied:
      mPromise->MaybeRejectWithSecurityError(
          "WebSerial requires a site permission add-on to activate");
      break;
    case CancellationReason::InternalError:
      mPromise->MaybeRejectWithNotSupportedError("Request failed");
      break;
  }

  return NS_OK;
}

NS_IMETHODIMP
SerialPermissionRequest::Allow(JS::Handle<JS::Value> aChoices) {
  // Parse selection from aChoices
  // Expected format: { serial: "0" }

  MOZ_LOG(gWebSerialLog, LogLevel::Info,
          ("SerialPermissionRequest::Allow called"));
  MOZ_LOG(gWebSerialLog, LogLevel::Debug,
          ("  mAvailablePorts.Length(): %zu", mAvailablePorts.Length()));

  if (!aChoices.isObject()) {
    MOZ_LOG(gWebSerialLog, LogLevel::Error, ("  aChoices is not an object"));
    mPromise->MaybeRejectWithNotSupportedError("Invalid selection passed");
    return NS_OK;
  }
  AutoJSAPI jsapi;
  if (!jsapi.Init(mWindow)) {
    MOZ_LOG(gWebSerialLog, LogLevel::Error, ("  Failed to initialize JS API"));
    mPromise->MaybeRejectWithNotSupportedError("Failed to initialize JS API");
    return NS_OK;
  }

  JSContext* cx = jsapi.cx();
  JS::Rooted<JSObject*> obj(cx, &aChoices.toObject());
  JS::Rooted<JS::Value> serialVal(cx);

  bool gotProperty = JS_GetProperty(cx, obj, "serial", &serialVal);
  MOZ_LOG(gWebSerialLog, LogLevel::Debug,
          ("  JS_GetProperty('serial') succeeded: %s",
           gotProperty ? "true" : "false"));

  if (!gotProperty) {
    MOZ_LOG(gWebSerialLog, LogLevel::Error,
            ("  aChoices does not have a serial property"));
    mPromise->MaybeRejectWithNotSupportedError(
        "Invalid selection (no serial property)");
    return NS_OK;
  }
  if (!serialVal.isString()) {
    MOZ_LOG(gWebSerialLog, LogLevel::Error,
            ("  aChoices['serial'] is not a string"));
    mPromise->MaybeRejectWithNotSupportedError(
        "Invalid selection (not a string)");
    return NS_OK;
  }
  nsAutoJSString choice;
  if (!choice.init(cx, serialVal)) {
    mPromise->MaybeRejectWithNotSupportedError("Invalid selection");
    return NS_OK;
  }
  nsresult rv;
  int32_t selectedPortIndex = choice.ToInteger(&rv);
  if (NS_FAILED(rv)) {
    MOZ_LOG(gWebSerialLog, LogLevel::Error,
            ("  Failed to convert serial string to integer"));
    mPromise->MaybeRejectWithNotSupportedError("Invalid selection value");
    return NS_OK;
  }
  MOZ_LOG(
      gWebSerialLog, LogLevel::Info,
      ("  Successfully parsed serial choice as string: %d", selectedPortIndex));

  // Validate index
  if (selectedPortIndex < 0 ||
      selectedPortIndex >= static_cast<int32_t>(mAvailablePorts.Length())) {
    MOZ_LOG(gWebSerialLog, LogLevel::Error,
            ("  Port selection out of range: index=%d, length=%zu",
             selectedPortIndex, mAvailablePorts.Length()));
    mPromise->MaybeRejectWithNotFoundError("Port selection out of range");
    return NS_OK;
  }

  // Get the selected port
  const IPCSerialPortInfo& selectedPort = mAvailablePorts[selectedPortIndex];

  MOZ_LOG(gWebSerialLog, LogLevel::Info,
          ("  Selected port at index %d:", selectedPortIndex));
  MOZ_LOG(gWebSerialLog, LogLevel::Info,
          ("    path: %s", NS_ConvertUTF16toUTF8(selectedPort.path()).get()));
  MOZ_LOG(gWebSerialLog, LogLevel::Info,
          ("    friendlyName: %s",
           NS_ConvertUTF16toUTF8(selectedPort.friendlyName()).get()));
  if (selectedPort.usbVendorId().isSome()) {
    MOZ_LOG(gWebSerialLog, LogLevel::Info,
            ("    usbVendorId: 0x%04x", selectedPort.usbVendorId().value()));
  }
  if (selectedPort.usbProductId().isSome()) {
    MOZ_LOG(gWebSerialLog, LogLevel::Info,
            ("    usbProductId: 0x%04x", selectedPort.usbProductId().value()));
  }

  RefPtr<SerialPort> port = mSerial->GetOrCreatePort(selectedPort);
  if (!port) {
    mPromise->MaybeRejectWithNotSupportedError("Failed to create port actor");
    return NS_OK;
  }
  port->MarkPhysicallyPresent();
  mPromise->MaybeResolve(port);

  return NS_OK;
}

bool SerialPermissionRequest::IsSitePermAllow() {
  return nsContentUtils::IsSitePermAllow(mPrincipal, "serial"_ns);
}

bool SerialPermissionRequest::IsSitePermDeny() {
  return nsContentUtils::IsSitePermDeny(mPrincipal, "serial"_ns);
}

NS_IMETHODIMP
SerialPermissionRequest::Run() {
  if (!IsSitePermAllow()) {
    if (IsSitePermDeny()) {
      CancelWithRandomizedDelay();
      return NS_OK;
    }

    if (nsContentUtils::IsSitePermDeny(mPrincipal, "install"_ns) &&
        StaticPrefs::dom_sitepermsaddon_provider_enabled() &&
        !mPrincipal->GetIsLoopbackHost()) {
      CancelWithRandomizedDelay();
      return NS_OK;
    }
  }

  AssertIsOnMainThread();

  RefPtr<SerialManagerChild> child = mSerial->GetOrCreateManagerChild();
  if (!child) {
    mCancellationReason = CancellationReason::InternalError;
    Cancel();
    return NS_ERROR_FAILURE;
  }

  // Fetch available ports
  RefPtr<SerialPermissionRequest> self = this;

  child->SendGetAvailablePorts()->Then(
      GetMainThreadSerialEventTarget(), __func__,
      [self](nsTArray<IPCSerialPortInfo>&& ports) {
        self->mAvailablePorts = std::move(ports);

        // Apply filters from requestPort() options
        if (!self->FilterPorts(self->mAvailablePorts)) {
          // There was an invalid filter
          self->Cancel();
          return;
        }

        // Check if we should auto-select for testing after filtering
        bool testingAutoselect = self->ShouldAutoselect();

        if (testingAutoselect && !StaticPrefs::dom_webserial_gated()) {
          // Testing mode or existing permission - auto-allow with first port
          // Or autoselect is enabled without gated mode
          self->Allow(JS::UndefinedHandleValue);
        } else {
          // Show the doorhanger for user selection
          // If testingAutoselect is enabled with gated mode, the doorhanger
          // will still show addon prompts but should auto-select the port
          if (NS_FAILED(self->DoPrompt())) {
            self->Cancel();
          }
        }
      },
      [self](mozilla::ipc::ResponseRejectReason&& aReason) {
        self->mCancellationReason = CancellationReason::InternalError;
        self->Cancel();
      });

  return NS_OK;
}

void SerialPermissionRequest::CancelWithRandomizedDelay() {
  AssertIsOnMainThread();

  // This is called when addon is denied
  mCancellationReason = CancellationReason::AddonDenied;

  uint32_t randomDelayMS =
      xpc::IsInAutomation()
          ? 0
          : RandomUint64OrDie() % kPermissionDeniedMaxRandomDelayMs;
  auto delay = TimeDuration::FromMilliseconds(kPermissionDeniedBaseDelayMs +
                                              randomDelayMS);
  NS_NewTimerWithCallback(
      getter_AddRefs(mCancelTimer),
      [self = RefPtr{this}](auto) { self->Cancel(); }, delay,
      nsITimer::TYPE_ONE_SHOT,
      "SerialPermissionRequest::CancelWithRandomizedDelay"_ns);
}

nsresult SerialPermissionRequest::DoPrompt() {
  // User is being shown the chooser - if they cancel, it's UserCancelled
  mCancellationReason = CancellationReason::UserCancelled;

  if (NS_FAILED(nsContentPermissionUtils::AskPermission(this, mWindow))) {
    // Prompt failed to show - this is an internal error
    mCancellationReason = CancellationReason::InternalError;
    Cancel();
    return NS_ERROR_FAILURE;
  }
  return NS_OK;
}

bool SerialPermissionRequest::FilterPorts(nsTArray<IPCSerialPortInfo>& aPorts) {
  if (!mOptions.mFilters.WasPassed()) {
    return true;
  }

  return Serial::ApplyPortFilters(aPorts, mOptions.mFilters.Value());
}

bool SerialPermissionRequest::ShouldAutoselect() const {
  return StaticPrefs::dom_webserial_testing_enabled() &&
         mSerial->AutoselectPorts();
}

}  // namespace mozilla::dom
