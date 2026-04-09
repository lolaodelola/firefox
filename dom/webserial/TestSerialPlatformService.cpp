/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et cindent: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "TestSerialPlatformService.h"

#include "SerialLogging.h"
#include "mozilla/StaticPrefs_dom.h"

namespace mozilla::dom {

TestSerialPlatformService::TestSerialPlatformService() {
  AddDefaultMockPorts();
}

TestSerialPlatformService* TestSerialPlatformService::AsTestService() {
  return this;
}

void TestSerialPlatformService::Shutdown() {
  if (IsShutdown()) {
    return;
  }
  MOZ_LOG(gWebSerialLog, LogLevel::Info,
          ("TestSerialPlatformService[%p]::Shutdown", this));
  mMockPorts.Clear();
  SerialPlatformService::Shutdown();
}

void TestSerialPlatformService::AddDefaultMockPorts() {
  AddMockDevice(u"test-device-1"_ns, u"/dev/ttyUSB0"_ns, 0x2341, 0x0043);
  AddMockDevice(u"test-device-2"_ns, u"/dev/ttyUSB1"_ns, 0x0403, 0x6002);
  AddMockDevice(u"test-device-3"_ns, u"/dev/ttyACM0"_ns, 0x1a86, 0x7523);
}

nsresult TestSerialPlatformService::EnumeratePortsImpl(SerialPortList& aPorts) {
  aPorts.Clear();

  for (const auto& port : mMockPorts) {
    aPorts.AppendElement(port.mInfo);
  }

  return NS_OK;
}

nsresult TestSerialPlatformService::OpenImpl(const nsString& aPortId,
                                             const IPCSerialOptions& aOptions) {
  MockSerialPort* port = FindPort(aPortId);
  if (!port) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  if (port->mIsOpen) {
    return NS_ERROR_ALREADY_INITIALIZED;
  }

  port->mIsOpen = true;
  port->mOptions = aOptions;
  return NS_OK;
}

nsresult TestSerialPlatformService::CloseImpl(const nsString& aPortId) {
  MockSerialPort* port = FindPort(aPortId);
  if (!port) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  if (!port->mIsOpen) {
    return NS_OK;
  }

  port->mIsOpen = false;
  port->mBuffer.Clear();
  return NS_OK;
}

nsresult TestSerialPlatformService::ReadImpl(const nsString& aPortId,
                                             Span<uint8_t> aBuf,
                                             uint32_t& aBytesRead) {
  MockSerialPort* port = FindPort(aPortId);
  if (!port || !port->mIsOpen) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  uint32_t toRead = std::min<uint32_t>(port->mBuffer.Length(), aBuf.Length());
  if (toRead == 0) {
    return NS_OK;
  }
  memcpy(aBuf.Elements(), port->mBuffer.Elements(), toRead);
  port->mBuffer.RemoveElementsAt(0, toRead);
  aBytesRead = toRead;
  return NS_OK;
}

nsresult TestSerialPlatformService::WriteImpl(const nsString& aPortId,
                                              Span<const uint8_t> aData) {
  MockSerialPort* port = FindPort(aPortId);
  if (!port || !port->mIsOpen) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  port->mBuffer.AppendElements(aData);

  return NS_OK;
}

nsresult TestSerialPlatformService::DrainImpl(const nsString& aPortId) {
  MockSerialPort* port = FindPort(aPortId);
  if (!port || !port->mIsOpen) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  return NS_OK;
}

nsresult TestSerialPlatformService::FlushImpl(const nsString& aPortId,
                                              bool aReceive) {
  MockSerialPort* port = FindPort(aPortId);
  if (!port || !port->mIsOpen) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  if (aReceive) {
    // Discard receive buffers: clear any data waiting to be read.
    port->mBuffer.Clear();
  }

  return NS_OK;
}

nsresult TestSerialPlatformService::SetSignalsImpl(
    const nsString& aPortId, const IPCSerialOutputSignals& aSignals) {
  MockSerialPort* port = FindPort(aPortId);
  if (!port || !port->mIsOpen) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  if (aSignals.dataTerminalReady().isSome()) {
    port->mOutputSignals.dataTerminalReady() = aSignals.dataTerminalReady();
  }
  if (aSignals.requestToSend().isSome()) {
    port->mOutputSignals.requestToSend() = aSignals.requestToSend();
  }
  if (aSignals.breakSignal().isSome()) {
    port->mOutputSignals.breakSignal() = aSignals.breakSignal();
  }
  return NS_OK;
}

nsresult TestSerialPlatformService::GetSignalsImpl(
    const nsString& aPortId, IPCSerialInputSignals& aSignals) {
  MockSerialPort* port = FindPort(aPortId);
  if (!port || !port->mIsOpen) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  aSignals = IPCSerialInputSignals{
      port->mOutputSignals.dataTerminalReady().valueOr(
          false),                                           // dataCarrierDetect
      port->mOutputSignals.requestToSend().valueOr(false),  // clearToSend
      false,                                                // ringIndicator
      port->mOutputSignals.dataTerminalReady().valueOr(false)  // dataSetReady
  };

  return NS_OK;
}

MockSerialPort TestSerialPlatformService::CreateMockPort(const nsString& aId,
                                                         const nsString& aPath,
                                                         uint16_t aVendorId,
                                                         uint16_t aProductId) {
  MockSerialPort port;
  port.mInfo.id() = aId;
  port.mInfo.path() = aPath;
  port.mInfo.friendlyName() = aId;
  port.mInfo.usbVendorId() = Some(aVendorId);
  port.mInfo.usbProductId() = Some(aProductId);
  return port;
}

void TestSerialPlatformService::AddMockDevice(const nsString& aId,
                                              const nsString& aPath,
                                              uint16_t aVendorId,
                                              uint16_t aProductId) {
  mMockPorts.AppendElement(CreateMockPort(aId, aPath, aVendorId, aProductId));
}

MockSerialPort* TestSerialPlatformService::FindPort(const nsString& aPortId) {
  for (auto& port : mMockPorts) {
    if (port.mInfo.id() == aPortId) {
      return &port;
    }
  }
  return nullptr;
}

void TestSerialPlatformService::SimulateDeviceConnection(const nsString& aId,
                                                         const nsString& aPath,
                                                         uint16_t aVendorId,
                                                         uint16_t aProductId) {
  MockSerialPort port = CreateMockPort(aId, aPath, aVendorId, aProductId);
  IPCSerialPortInfo info = port.mInfo;
  mMockPorts.AppendElement(std::move(port));
  NotifyPortConnected(info);
}

void TestSerialPlatformService::SimulateDeviceDisconnection(
    const nsString& aId) {
  mMockPorts.RemoveElementsBy(
      [&aId](const MockSerialPort& port) { return port.mInfo.id() == aId; });
  NotifyPortDisconnected(aId);
}

void TestSerialPlatformService::RemoveAllMockDevices() {
  MOZ_LOG(gWebSerialLog, LogLevel::Info,
          ("TestSerialPlatformService::RemoveAllMockDevices removing %zu "
           "devices",
           mMockPorts.Length()));

  // Notify disconnection for each device before removing
  for (const auto& mockPort : mMockPorts) {
    NotifyPortDisconnected(mockPort.mInfo.id());
  }

  mMockPorts.Clear();
}

void TestSerialPlatformService::ResetToDefaultMockDevices() {
  MOZ_LOG(gWebSerialLog, LogLevel::Info,
          ("TestSerialPlatformService::ResetToDefaultMockDevices"));
  RemoveAllMockDevices();
  AddDefaultMockPorts();
}
}  // namespace mozilla::dom
