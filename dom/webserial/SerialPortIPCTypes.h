/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_SerialPortIPCTypes_h
#define mozilla_dom_SerialPortIPCTypes_h

#include "mozilla/dom/BindingIPCUtils.h"
#include "mozilla/dom/SerialPortBinding.h"

namespace mozilla::dom {
constexpr uint32_t kMaxSerialBufferSize = 16u * 1024u * 1024u;  // 16 MiB
}  // namespace mozilla::dom

namespace IPC {
template <>
struct ParamTraits<mozilla::dom::ParityType>
    : public mozilla::dom::WebIDLEnumSerializer<mozilla::dom::ParityType> {};

template <>
struct ParamTraits<mozilla::dom::FlowControlType>
    : public mozilla::dom::WebIDLEnumSerializer<mozilla::dom::FlowControlType> {
};
}  // namespace IPC

#endif  // mozilla_dom_SerialPortIPCTypes_h
