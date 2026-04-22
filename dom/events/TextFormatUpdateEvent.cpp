/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "TextFormatUpdateEvent.h"

namespace mozilla::dom {

NS_IMPL_ADDREF_INHERITED(TextFormatUpdateEvent, Event)
NS_IMPL_RELEASE_INHERITED(TextFormatUpdateEvent, Event)
NS_IMPL_CYCLE_COLLECTION(TextFormatUpdateEvent)

NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(TextFormatUpdateEvent)
NS_INTERFACE_MAP_END_INHERITING(Event)

already_AddRefed<TextFormatUpdateEvent> TextFormatUpdateEvent::Constructor(
    const GlobalObject& aGlobal, const nsAString& aType,
    const TextFormatUpdateEventInit& aOptions) {
  nsCOMPtr<mozilla::dom::EventTarget> target =
      do_QueryInterface(aGlobal.GetAsSupports());
  RefPtr<TextFormatUpdateEvent> event = new TextFormatUpdateEvent(target);
  event->InitEvent(aType, aOptions.mBubbles, aOptions.mCancelable);
  // TODO: initialize text formats from aOptions
  bool trusted = event->Init(target);
  event->SetTrusted(trusted);
  return event.forget();
}

JSObject* TextFormatUpdateEvent::WrapObjectInternal(
    JSContext* aCx, JS::Handle<JSObject*> aGivenProto) {
  return mozilla::dom::TextFormatUpdateEvent_Binding::Wrap(aCx, this,
                                                           aGivenProto);
}

}  // namespace mozilla::dom
