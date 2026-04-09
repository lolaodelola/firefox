/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et cindent: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "SerialPortPumps.h"

#include "SerialLogging.h"

namespace mozilla::dom::webserial {

namespace {
constexpr uint32_t kReadPollIntervalMs = 20;
constexpr uint32_t kReadBufferSize = 4096;
}  // namespace

NS_IMPL_ISUPPORTS_INHERITED(SerialPortReadPump, Runnable,
                            nsIOutputStreamCallback)

SerialPortReadPump::SerialPortReadPump(const nsString& aPortId,
                                       nsIAsyncOutputStream* aOutput)
    : Runnable("SerialPortReadPump"), mPortId(aPortId), mOutput(aOutput) {}

void SerialPortReadPump::Stop() {
  MOZ_LOG(gWebSerialLog, LogLevel::Debug,
          ("SerialPortReadPump::Stop for port '%s'",
           NS_ConvertUTF16toUTF8(mPortId).get()));
  mStopped = true;
  if (mOutput) {
    mOutput->CloseWithStatus(NS_BASE_STREAM_CLOSED);
  }
}

NS_IMETHODIMP SerialPortReadPump::Run() {
  if (mStopped) {
    return NS_OK;
  }

  RefPtr<SerialPlatformService> service = SerialPlatformService::GetInstance();
  if (!service) {
    MOZ_LOG(gWebSerialLog, LogLevel::Error,
            ("SerialPortReadPump::Run no platform service for port '%s'",
             NS_ConvertUTF16toUTF8(mPortId).get()));
    return NS_OK;
  }

  service->AssertIsOnIOThread();

  // If we have pending data from a previous partial write, try to flush it.
  while (mPendingData.Length() > mPendingOffset) {
    uint32_t written = 0;
    nsresult rv = mOutput->Write(
        reinterpret_cast<const char*>(mPendingData.Elements() + mPendingOffset),
        mPendingData.Length() - mPendingOffset, &written);
    if (rv == NS_BASE_STREAM_WOULD_BLOCK) {
      mOutput->AsyncWait(this, 0, 0, service->IOThread());
      return NS_OK;
    }
    if (NS_FAILED(rv)) {
      MOZ_LOG(
          gWebSerialLog, LogLevel::Error,
          ("SerialPortReadPump pipe write failed for port '%s': 0x%08x",
           NS_ConvertUTF16toUTF8(mPortId).get(), static_cast<uint32_t>(rv)));
      return NS_OK;
    }
    mPendingOffset += written;
  }
  mPendingData.ClearAndRetainStorage();
  mPendingOffset = 0;

  // Read from the serial device (may block up to ~5ms if no data).
  nsTArray<uint8_t> data;
  data.SetLength(kReadBufferSize);
  uint32_t bytesRead = 0;
  nsresult rv = service->Read(mPortId, Span(data), bytesRead);

  if (NS_FAILED(rv)) {
    MOZ_LOG(gWebSerialLog, LogLevel::Error,
            ("SerialPortReadPump read failed for port '%s': 0x%08x",
             NS_ConvertUTF16toUTF8(mPortId).get(), static_cast<uint32_t>(rv)));
    mOutput->CloseWithStatus(rv);
    return NS_OK;
  }

  if (mStopped) {
    return NS_OK;
  }

  if (bytesRead > 0) {
    data.SetLength(bytesRead);

    // Write to the local nsIPipe. This is non-blocking (the nsIPipe is
    // in-process with no cross-process mutex). NS_AsyncCopy on a separate
    // thread handles moving data from the nsIPipe to the DataPipeSender.
    uint32_t totalWritten = 0;
    while (totalWritten < data.Length()) {
      uint32_t written = 0;
      rv = mOutput->Write(
          reinterpret_cast<const char*>(data.Elements() + totalWritten),
          data.Length() - totalWritten, &written);
      if (rv == NS_BASE_STREAM_WOULD_BLOCK) {
        // Pipe full; save remainder and wait for space.
        mPendingData = std::move(data);
        mPendingOffset = totalWritten;
        mOutput->AsyncWait(this, 0, 0, service->IOThread());
        return NS_OK;
      }
      if (NS_FAILED(rv)) {
        MOZ_LOG(
            gWebSerialLog, LogLevel::Error,
            ("SerialPortReadPump pipe write failed for port '%s': 0x%08x",
             NS_ConvertUTF16toUTF8(mPortId).get(), static_cast<uint32_t>(rv)));
        return NS_OK;
      }
      totalWritten += written;
    }

    // All data written; immediately poll for more.
    service->IOThread()->Dispatch(do_AddRef(this), NS_DISPATCH_NORMAL);
  } else {
    // No data available; poll again after a delay.
    service->IOThread()->DelayedDispatch(do_AddRef(this), kReadPollIntervalMs);
  }

  return NS_OK;
}

NS_IMETHODIMP SerialPortReadPump::OnOutputStreamReady(
    nsIAsyncOutputStream* aStream) {
  if (mStopped) {
    return NS_OK;
  }

  // Pipe has space available. Re-dispatch ourselves to continue.
  RefPtr<SerialPlatformService> service = SerialPlatformService::GetInstance();
  if (service) {
    service->IOThread()->Dispatch(do_AddRef(this), NS_DISPATCH_NORMAL);
  }
  return NS_OK;
}

NS_IMPL_ISUPPORTS(SerialPortWritePump, nsIInputStreamCallback)

SerialPortWritePump::SerialPortWritePump(const nsString& aPortId,
                                         nsIAsyncInputStream* aInput)
    : mPortId(aPortId), mInput(aInput) {}

void SerialPortWritePump::Start() {
  RefPtr<SerialPlatformService> service = SerialPlatformService::GetInstance();
  if (service && mInput) {
    mInput->AsyncWait(this, 0, 0, service->IOThread());
  }
}

void SerialPortWritePump::Stop() {
  MOZ_LOG(gWebSerialLog, LogLevel::Debug,
          ("SerialPortWritePump::Stop for port '%s'",
           NS_ConvertUTF16toUTF8(mPortId).get()));
  mStopped = true;
}

NS_IMETHODIMP SerialPortWritePump::OnInputStreamReady(
    nsIAsyncInputStream* aStream) {
  if (mStopped) {
    return NS_OK;
  }

  RefPtr<SerialPlatformService> service = SerialPlatformService::GetInstance();
  if (!service) {
    return NS_OK;
  }

  service->AssertIsOnIOThread();

  // Read available data from the DataPipeReceiver.
  char buf[4096];
  uint32_t bytesRead = 0;
  nsresult rv = mInput->Read(buf, sizeof(buf), &bytesRead);

  if (rv == NS_BASE_STREAM_WOULD_BLOCK) {
    // No data yet, wait again.
    mInput->AsyncWait(this, 0, 0, service->IOThread());
    return NS_OK;
  }

  // NS_OK with 0 bytes is the nsIInputStream EOF convention. DataPipe
  // returns this when the peer (sender) has closed and no data remains.
  if (NS_FAILED(rv) || (NS_SUCCEEDED(rv) && bytesRead == 0)) {
    MOZ_LOG(gWebSerialLog, LogLevel::Debug,
            ("SerialPortWritePump pipe closed/error for port '%s': 0x%08x",
             NS_ConvertUTF16toUTF8(mPortId).get(), static_cast<uint32_t>(rv)));
    mPipeClosed = true;
    if (nsCOMPtr<nsIRunnable> cb = mClosedCallback.forget()) {
      cb->Run();
    }
    return NS_OK;
  }

  if (bytesRead > 0) {
    MOZ_LOG(gWebSerialLog, LogLevel::Verbose,
            ("SerialPortWritePump writing %u bytes to port '%s'", bytesRead,
             NS_ConvertUTF16toUTF8(mPortId).get()));

    nsTArray<uint8_t> data;
    data.AppendElements(reinterpret_cast<const uint8_t*>(buf), bytesRead);
    rv = service->Write(mPortId, data);
    if (NS_FAILED(rv)) {
      MOZ_LOG(
          gWebSerialLog, LogLevel::Error,
          ("SerialPortWritePump device write failed for port '%s': 0x%08x",
           NS_ConvertUTF16toUTF8(mPortId).get(), static_cast<uint32_t>(rv)));
      // Close the pipe to signal the error back to the child.
      mInput->CloseWithStatus(rv);
      return NS_OK;
    }
  }

  // Wait for more data.
  if (!mStopped) {
    mInput->AsyncWait(this, 0, 0, service->IOThread());
  }

  return NS_OK;
}

void SerialPortWritePump::OnPipeClosed(nsCOMPtr<nsIRunnable>&& aCallback) {
  RefPtr<SerialPlatformService> service = SerialPlatformService::GetInstance();
  MOZ_DIAGNOSTIC_ASSERT(service && service->IOThread()->IsOnCurrentThread());
  if (mPipeClosed) {
    aCallback->Run();
    return;
  }
  mClosedCallback = std::move(aCallback);
}

}  // namespace mozilla::dom::webserial
