/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/media/CamerasIPCUtils.h"

namespace webrtc {
enum class VideoType {};
struct VideoCaptureCapability {};
}  // namespace webrtc

namespace IPC {
struct WebrtcVideoTypeValidator {
  static bool IsLegalValue(int e) { return false; }
};

void ParamTraits<webrtc::VideoCaptureCapability>::Write(
    MessageWriter* aWriter, const paramType& aParam) {}
bool ParamTraits<webrtc::VideoCaptureCapability>::Read(MessageReader* aReader,
                                                       paramType* aResult) {
  *aResult = {};
  return true;
}
}  // namespace IPC
