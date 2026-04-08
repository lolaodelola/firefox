/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef BASEALLOC_H
#define BASEALLOC_H

#include "Constants.h"
#include "Mutex.h"
#include "Utils.h"

#include "mozilla/DoublyLinkedList.h"
#include "mozilla/fallible.h"

// Allocation sizes must fit in a uint32_t
typedef uint32_t base_alloc_size_t;
constexpr static base_alloc_size_t BASE_ALLOC_SIZE_MAX = UINT32_MAX;

class BaseAllocCell;

// The base allocator is a simple memory allocator used internally by
// mozjemalloc for its own structures.
class BaseAlloc {
 public:
  constexpr BaseAlloc() {};

  void Init() MOZ_REQUIRES(gInitLock);

  void* alloc(size_t aSize) MOZ_EXCLUDES(mMutex);

  void* calloc(size_t aNumber, size_t aSize) MOZ_EXCLUDES(mMutex);

  // usable_size is safe both with and without the lock.
  size_t usable_size(void* aPtr);

  void free(void* aPtr) MOZ_EXCLUDES(mMutex);

  Mutex mMutex;

  struct Stats {
    size_t mMapped = 0;
    size_t mCommitted = 0;
  };
  Stats GetStats() MOZ_EXCLUDES(mMutex) {
    MutexAutoLock lock(mMutex);

    MOZ_ASSERT(mStats.mMapped >= mStats.mCommitted);
    return mStats;
  }

 private:
  // Return the free list for the smallest size at least this big.
  unsigned get_list_index_for_size_at_least(base_alloc_size_t aSize);
  // Return the free list for the largest size at most this big.
  unsigned get_list_index_for_size_at_most(base_alloc_size_t aSize);

  // Allocate from a free list.
  void* alloc_from_list(base_alloc_size_t aSize) MOZ_REQUIRES(mMutex);

  // The largest allocation made with base alloc is currently arena_t.
  // Ensure there are enough size classes to cover allocations that big.
  // It is currently 2608 bytes, but we can't use sizeof(arena_t) here
  // because it creates a circular reference.
  constexpr static base_alloc_size_t NUM_LIST_SIZES = 2608 / kCacheLineSize + 1;
  mozilla::DoublyLinkedList<BaseAllocCell>
      mFreeLists[NUM_LIST_SIZES] MOZ_GUARDED_BY(mMutex);
  mozilla::DoublyLinkedList<BaseAllocCell> mFreeListOversize
      MOZ_GUARDED_BY(mMutex);

  // Attempt an allocation within the "wilderness" of already mapped chunks.
  BaseAllocCell* wilderness_alloc_inplace(base_alloc_size_t aSize)
      MOZ_REQUIRES(mMutex);

  // Attempt an allocation from "wilderness", first from already mapped
  // chunks and failing that allow new chunks to be mapped.
  BaseAllocCell* wilderness_alloc(base_alloc_size_t aSize) MOZ_REQUIRES(mMutex);

  // Allocate fresh pages to satsify at least aSize.
  bool pages_alloc(base_alloc_size_t aSize) MOZ_REQUIRES(mMutex);

  // BaseAlloc's wilderness uses bump-pointer allocation from mNextAddr.  In
  // general mNextAddr <= mNextDecommitted <= mPastAddr.
  //
  // If an allocation would cause mNextAddr > mPastAddr then a new chunk is
  // required (from pages_alloc()).  Else-if an allocation would case
  // mNextAddr > mNextDecommitted then some of the memory is decommitted and
  // pages_committ() is needed before the memory can be used.
  uintptr_t mNextAddr MOZ_GUARDED_BY(mMutex) = 0;
  uintptr_t mNextDecommitted MOZ_GUARDED_BY(mMutex) = 0;
  // Address immediately past the current chunk of pages.
  uintptr_t mPastAddr MOZ_GUARDED_BY(mMutex) = 0;

  Stats mStats MOZ_GUARDED_BY(mMutex);
};

extern BaseAlloc sBaseAlloc;

// Other classes may inherit from BaseAllocClass to get new and delete
// methods that use the base allocator.
struct BaseAllocClass {
  void* operator new(size_t aSize) noexcept {
    void* ret = sBaseAlloc.alloc(aSize);
    if (!ret) {
      _malloc_message(_getprogname(), ": (malloc) Out of memory\n");
      MOZ_CRASH();
    }
    return ret;
  }
  void* operator new[](size_t aSize) noexcept {
    void* ret = sBaseAlloc.alloc(aSize);
    if (!ret) {
      _malloc_message(_getprogname(), ": (malloc) Out of memory\n");
      MOZ_CRASH();
    }
    return ret;
  }
  void* operator new(size_t aCount, const mozilla::fallible_t&) noexcept {
    return sBaseAlloc.alloc(aCount);
  }
  void* operator new[](size_t aCount, const mozilla::fallible_t&) noexcept {
    return sBaseAlloc.alloc(aCount);
  }

  void operator delete(void* aPtr) { sBaseAlloc.free(aPtr); }
  void operator delete[](void* aPtr) { sBaseAlloc.free(aPtr); }
};

#endif /* ! BASEALLOC_H */
