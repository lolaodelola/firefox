/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "EditContext.h"

#include "mozilla/ClearOnShutdown.h"
#include "mozilla/ErrorResult.h"
#include "mozilla/dom/Element.h"

namespace mozilla::dom {

NS_IMPL_ADDREF_INHERITED(EditContext, DOMEventTargetHelper)
NS_IMPL_RELEASE_INHERITED(EditContext, DOMEventTargetHelper)
NS_IMPL_CYCLE_COLLECTION(EditContext)

NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(EditContext)
NS_INTERFACE_MAP_END_INHERITING(DOMEventTargetHelper)

already_AddRefed<EditContext> EditContext::Constructor(
    const GlobalObject& aGlobal, const EditContextInit& aInit,
    ErrorResult& aRv) {
  nsCOMPtr<nsIGlobalObject> global = do_QueryInterface(aGlobal.GetAsSupports());
  if (!global) {
    aRv.Throw(NS_ERROR_FAILURE);
    return nullptr;
  }
  RefPtr<EditContext> context = new EditContext(global, aInit);
  return context.forget();
}

JSObject* EditContext::WrapObject(JSContext* aCx,
                                  JS::Handle<JSObject*> aGivenProto) {
  return EditContext_Binding::Wrap(aCx, this, aGivenProto);
}

static StaticAutoPtr<nsTHashMap<const Element*, RefPtr<EditContext>>>
    sEditContextHashMap;

// static
EditContext* EditContext::GetForElement(const Element& aElement) {
  MOZ_ASSERT(NS_IsMainThread());
  if (!sEditContextHashMap || !aElement.HasFlag(ELEMENT_HAS_EDIT_CONTEXT)) {
    return nullptr;
  }
  auto entry = sEditContextHashMap->Lookup(&aElement);
  MOZ_ASSERT(entry,
             "Should be in hash map if ELEMENT_HAS_EDIT_CONTEXT is set.");
  return entry.Data();
}

// static
void EditContext::SetForElement(const Element& aElement,
                                mozilla::dom::EditContext* aEditContext) {
  MOZ_ASSERT(NS_IsMainThread());
  if (!sEditContextHashMap) {
    if (!aEditContext) {
      return;
    }
    sEditContextHashMap = new nsTHashMap<const Element*, RefPtr<EditContext>>;
    ClearOnShutdown(&sEditContextHashMap);
  }
  if (aEditContext) {
    sEditContextHashMap->InsertOrUpdate(&aElement, aEditContext);
  } else {
    sEditContextHashMap->Remove(&aElement);
  }
}

}  // namespace mozilla::dom
