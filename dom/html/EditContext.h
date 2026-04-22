/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_EditContext_h
#define mozilla_dom_EditContext_h

#include "mozilla/DOMEventTargetHelper.h"
#include "mozilla/dom/EditContextBinding.h"

namespace mozilla::dom {

class EditContext final : public DOMEventTargetHelper {
 public:
  NS_DECL_ISUPPORTS_INHERITED
  NS_DECL_CYCLE_COLLECTION_CLASS_INHERITED(EditContext, DOMEventTargetHelper)

  JSObject* WrapObject(JSContext* aCx,
                       JS::Handle<JSObject*> aGivenProto) override;

  static already_AddRefed<EditContext> Constructor(const GlobalObject& aGlobal,
                                                   const EditContextInit& aInit,
                                                   ErrorResult& aRv);

  void UpdateText(uint32_t aRangeStart, uint32_t aRangeEnd,
                  const nsAString& aText) {}
  void UpdateSelection(uint32_t aStart, uint32_t aEnd) {}
  void UpdateControlBounds(DOMRect& aControlBounds) {}
  void UpdateSelectionBounds(DOMRect& aSelectionBounds) {}
  void UpdateCharacterBounds(
      uint32_t aRangeStart,
      const Sequence<OwningNonNull<DOMRect>>& aCharacterBounds) {}
  void AttachedElements(nsTArray<RefPtr<nsGenericHTMLElement>>& aRetVal) {}

  void GetText(nsAString& aText) const {}
  uint32_t SelectionStart() const { return 0; }
  uint32_t SelectionEnd() const { return 0; }
  uint32_t CharacterBoundsRangeStart() const { return 0; }
  void CharacterBounds(nsTArray<RefPtr<DOMRect>>& aRetVal) {}

  IMPL_EVENT_HANDLER(characterboundsupdate);
  IMPL_EVENT_HANDLER(compositionstart);
  IMPL_EVENT_HANDLER(compositionend);
  IMPL_EVENT_HANDLER(textformatupdate);
  IMPL_EVENT_HANDLER(textupdate);

  static EditContext* GetForElement(const Element& aElement);
  static void SetForElement(const Element& aElement, EditContext* aEditContext);

 private:
  explicit EditContext(nsIGlobalObject* aGlobalObject,
                       const EditContextInit& aInit)
      : DOMEventTargetHelper(aGlobalObject) {}
  ~EditContext() = default;
};

}  // namespace mozilla::dom

#endif
