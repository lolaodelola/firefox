/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "modules/video_capture/video_capture_defines.h"
#include "mozilla/media/CamerasIPCUtils.h"

namespace IPC {
struct WebrtcVideoTypeValidator
    : ContiguousEnumValidatorInclusive<webrtc::VideoType,
                                       webrtc::VideoType::kUnknown,
                                       webrtc::VideoType::kNV12> {};

IMPLEMENT_IPC_SERIALIZER_WITH_FIELDS(webrtc::VideoCaptureCapability, width,
                                     height, maxFPS, videoType, interlaced);
}  // namespace IPC
