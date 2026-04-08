/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef BASEALLOCINTERNALS_H
#define BASEALLOCINTERNALS_H

#include <algorithm>

#include "mozilla/DoublyLinkedList.h"

#include "BaseAlloc.h"

// Allocation sizes must fit in a 31 bit unsigned integer.
typedef uint32_t base_alloc_size_t;
constexpr static base_alloc_size_t BASE_ALLOC_SIZE_MAX = UINT32_MAX >> 1;

// Implemtnation details for the base allocator.  These must be in a header
// file so that the C++ compiler can find them, but they're not part of the
// interface.

// The BaseAllocMetadata and BaseAllocCell classes provide an abstraction for
// cell metadata in the base allocator.
//
// The layout of a cell is:
//
// +-------------------+---------------+-------------------
// | BaseAllocMetadata | BaseAllocCell | BaseAllocMetadata
// +-------------------+---------------+-------------------
//                     ^
//                     Pointer, 16-byte aligned.
//
// All cells track their size in the `sizeof(base_alloc_size_t)` bytes
// immediately before their payload,
//
// Each cell's payload shall be 16-byte aligned as some platforms make it
// the minimum.
//
// Each cell's payload should be on its own cache line(s) (from other
// payloads) to avoid false sharing during use.  Note that this allows the
// size field of one cell to be on another cell's cache line.  We assume
// that allocations and frees in the base allocator are rare and this false
// sharing of the metadata acceptable.
//
// Unallocated cell layout replaces the payload with pointers to manage a
// free list.  This is not a security risk since these allocations are never
// used outside of mozjemalloc.
//
// +--------------+-------------------+-------------------
// | Size / Alloc | Free list ptr     | Next Size / Alloc
// +--------------+-------------------+-------------------
//

struct BaseAllocMetadata {
  base_alloc_size_t mSize : 31;

  // Allocated is only used for assertions, but will be used with future
  // patches.
  bool mAllocated : 1;

  explicit BaseAllocMetadata(base_alloc_size_t aSize)
      : mSize(aSize), mAllocated(false) {}
};

class BaseAllocCell {
 private:
  mozilla::DoublyLinkedListElement<BaseAllocCell> mListElem;

  friend struct mozilla::GetDoublyLinkedListElement<BaseAllocCell>;

  BaseAllocMetadata* Metadata() {
    // Assert that the address computation here produces a properly aligned
    // result.
    static_assert(((alignof(BaseAllocCell) - sizeof(BaseAllocMetadata)) %
                   alignof(BaseAllocMetadata)) == 0);

    return reinterpret_cast<BaseAllocMetadata*>(
        reinterpret_cast<uintptr_t>(this) - sizeof(BaseAllocMetadata));
  }

 public:
  static constexpr uintptr_t RoundUp(uintptr_t aValue) {
    const size_t align = std::max(alignof(BaseAllocCell), size_t(16));
    return ALIGNMENT_CEILING(aValue, align);
  }

  explicit BaseAllocCell(base_alloc_size_t aSize) {
    new (Metadata()) BaseAllocMetadata(aSize);
  }

  static BaseAllocCell* GetCell(void* aPtr) {
    return reinterpret_cast<BaseAllocCell*>(aPtr);
  }

  base_alloc_size_t Size() { return Metadata()->mSize; }

  bool Allocated() { return Metadata()->mAllocated; }

  void* Ptr() { return this; }

  void SetAllocated() {
    MOZ_ASSERT(!Allocated());
    Metadata()->mAllocated = true;
  }
  void SetFreed() {
    MOZ_ASSERT(Allocated());
    Metadata()->mAllocated = false;
  }

  // After freeing a cell but before we can use the list pointers we must
  // clear them to avoid assertions in DoublyLinkedList.
  void ClearPayload();

  // disable copy, move and new since this class must only be used in-place.
  BaseAllocCell(const BaseAllocCell&) = delete;
  void operator=(const BaseAllocCell&) = delete;
  BaseAllocCell(BaseAllocCell&&) = delete;
  void operator=(BaseAllocCell&&) = delete;
  void* operator new(size_t) = delete;
  void* operator new(size_t aSize, void* aPtr) {
    MOZ_ASSERT(aSize == sizeof(BaseAllocCell));
    return aPtr;
  }
  void* operator new[](size_t) = delete;
};

template <>
struct mozilla::GetDoublyLinkedListElement<BaseAllocCell> {
  static DoublyLinkedListElement<BaseAllocCell>& Get(BaseAllocCell* aCell) {
    return aCell->mListElem;
  }
  static const DoublyLinkedListElement<BaseAllocCell>& Get(
      const BaseAllocCell* aCell) {
    return aCell->mListElem;
  }
};

#endif /* ~ BASEALLOCINTERNALS_H */
