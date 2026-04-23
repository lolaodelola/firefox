/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_CamerasIPCUtils_h
#define mozilla_CamerasIPCUtils_h

#include "ipc/EnumSerializer.h"
#include "ipc/IPCMessageUtils.h"

namespace webrtc {
enum class VideoType;
struct VideoCaptureCapability;
}  // namespace webrtc

namespace IPC {

struct WebrtcVideoTypeValidator;
template <>
struct ParamTraits<webrtc::VideoType>
    : EnumSerializer<webrtc::VideoType, WebrtcVideoTypeValidator> {};

DECLARE_IPC_SERIALIZER(webrtc::VideoCaptureCapability)

}  // namespace IPC

#endif  // mozilla_CamerasIPCUtils_h
