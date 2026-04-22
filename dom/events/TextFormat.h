/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_TextFormat_h_
#define mozilla_dom_TextFormat_h_

#include "mozilla/dom/TextFormatBinding.h"
#include "nsWrapperCache.h"

class nsIGlobalObject;

namespace mozilla::dom {

class TextFormat final : public nsISupports, public nsWrapperCache {
 public:
  NS_DECL_CYCLE_COLLECTING_ISUPPORTS
  NS_DECL_CYCLE_COLLECTION_WRAPPERCACHE_CLASS(TextFormat)

  nsIGlobalObject* GetParentObject() const { return mOwner; }

  JSObject* WrapObject(JSContext* aCx,
                       JS::Handle<JSObject*> aGivenProto) override;

  static already_AddRefed<TextFormat> Constructor(
      const GlobalObject& aGlobal, const TextFormatInit& aOptions);

  uint32_t RangeStart() const { return 0; }

  uint32_t RangeEnd() const { return 0; }

  UnderlineStyle UnderlineStyle() const { return UnderlineStyle::None; }

  UnderlineThickness UnderlineThickness() const {
    return UnderlineThickness::None;
  }

 private:
  explicit TextFormat(nsIGlobalObject* aOwner);
  ~TextFormat() = default;

  nsCOMPtr<nsIGlobalObject> mOwner;
};

}  // namespace mozilla::dom

#endif  // DOM_TEXTFORMAT_H_
