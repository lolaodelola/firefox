/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "BaseAlloc.h"

#include <algorithm>
#include <cstring>

#include "Globals.h"

using namespace mozilla;

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
// +------+-------------------+-----------
// | Size | Free list ptr     | Next Size
// +------+-------------------+-----------
//

struct BaseAllocMetadata {
  base_alloc_size_t mSize;

  explicit BaseAllocMetadata(base_alloc_size_t aSize) : mSize(aSize) {}
};

class BaseAllocCell {
 private:
  DoublyLinkedListElement<BaseAllocCell> mListElem;

  friend struct GetDoublyLinkedListElement<BaseAllocCell>;

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

  base_alloc_size_t& Size() { return Metadata()->mSize; }

  void* Ptr() { return this; }

  // After freeing a cell but before we can use the list pointers we must
  // clear them to avoid assertions in DoublyLinkedList.
  void ClearPayload() { memset(&mListElem, 0, sizeof(mListElem)); }

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
struct GetDoublyLinkedListElement<BaseAllocCell> {
  static DoublyLinkedListElement<BaseAllocCell>& Get(BaseAllocCell* aCell) {
    return aCell->mListElem;
  }
  static const DoublyLinkedListElement<BaseAllocCell>& Get(
      const BaseAllocCell* aCell) {
    return aCell->mListElem;
  }
};

constinit BaseAlloc sBaseAlloc;

// Initialize base allocation data structures.
void BaseAlloc::Init() MOZ_REQUIRES(gInitLock) { mMutex.Init(); }

// We round requests for cell up to the next bin, and freeing a cell
// and putting it back in a bin will round it down.  This means that a cell
// that is not an even cacheline size will not be used by the next
// allocation of the same size.  We'll address this in a later patch.
unsigned BaseAlloc::get_list_index_for_size_at_least(base_alloc_size_t aSize) {
  return CACHELINE_CEILING(aSize) / kCacheLineSize;
}

unsigned BaseAlloc::get_list_index_for_size_at_most(base_alloc_size_t aSize) {
  return aSize / kCacheLineSize;
}

void BaseAlloc::free(void* aPtr) MOZ_EXCLUDES(mMutex) {
  if (aPtr == nullptr) {
    return;
  }

  MutexAutoLock lock(mMutex);

  BaseAllocCell* cell = BaseAllocCell::GetCell(aPtr);

  // Zero the contents of the memory cell before we add it to a free list.
  // Otherwise the DoublyLinkedList code will hit an assertion because it
  // looks like it's already in a list.
  cell->ClearPayload();

  // TODO attempt coalesce.

  unsigned index = get_list_index_for_size_at_most(cell->Size());
  if (index < NUM_LIST_SIZES) {
    mFreeLists[index].pushFront(cell);
  } else {
    mFreeListOversize.pushFront(cell);
  }
}

void* BaseAlloc::alloc(size_t aSize) {
  aSize = BaseAllocCell::RoundUp(std::max(aSize, sizeof(BaseAllocCell)));

  // Allocations cannot exceed sizes greater than BASE_ALLOC_SIZE_MAX which
  // is required by BaseAlloc's heap structure.  We assert but also return
  // null for builds without assertions.
  MOZ_ASSERT(aSize <= BASE_ALLOC_SIZE_MAX);
  if (aSize > BASE_ALLOC_SIZE_MAX) {
    return nullptr;
  }

  MutexAutoLock lock(mMutex);

  void* ret = alloc_from_list(aSize);
  if (ret) {
    return ret;
  }

  return wilderness_alloc(aSize);
}

void* BaseAlloc::alloc_from_list(base_alloc_size_t aSize) {
  unsigned start_index = get_list_index_for_size_at_least(aSize);
  for (unsigned i = start_index; i < NUM_LIST_SIZES; i++) {
    if (!mFreeLists[i].isEmpty()) {
      BaseAllocCell* cell = mFreeLists[i].popFront();
      // TODO attempt split.
      return cell->Ptr();
    }
  }

  // Linear scan the final free list, TODO: improve this with a tree.
  for (auto& cell : mFreeListOversize) {
    if (cell.Size() >= aSize) {
      mFreeListOversize.remove(&cell);

      return cell.Ptr();
    }
  }

  return nullptr;
}

bool BaseAlloc::pages_alloc(base_alloc_size_t aSize) MOZ_REQUIRES(mMutex) {
  // aSize should be non-zero and aligned already.
  MOZ_ASSERT(aSize != 0);
  MOZ_ASSERT(aSize == BaseAllocCell::RoundUp(aSize));

  // Make room for the metadata.
  base_alloc_size_t gross_size =
      BaseAllocCell::RoundUp(sizeof(BaseAllocMetadata)) + aSize;

  size_t csize = CHUNK_CEILING(gross_size);
  uintptr_t base_pages =
      reinterpret_cast<uintptr_t>(chunk_alloc(csize, kChunkSize, true));
  if (base_pages == 0) {
    return false;
  }
  mPastAddr = base_pages + csize;

  // Set mNext so that there's enough space for the first cell's metadata.
  mNextAddr = BaseAllocCell::RoundUp(base_pages + sizeof(BaseAllocMetadata));
  MOZ_ASSERT(mNextAddr <= mPastAddr);

  // Leave enough pages committed, otherwise they would have to be
  // immediately recommitted.
  mNextDecommitted = REAL_PAGE_CEILING(mNextAddr + aSize);
  if (mNextDecommitted < mPastAddr) {
    pages_decommit(reinterpret_cast<void*>(mNextDecommitted),
                   mPastAddr - mNextDecommitted);
  }
  mStats.mMapped += csize;
  mStats.mCommitted += mNextDecommitted - base_pages;

  return true;
}

BaseAllocCell* BaseAlloc::wilderness_alloc_inplace(base_alloc_size_t aSize) {
  if (mNextAddr == 0) {
    return nullptr;
  }

  // The last byte in the cell.
  uintptr_t end_of_cell = mNextAddr + aSize - 1;

  uintptr_t next_cell =
      BaseAllocCell::RoundUp(mNextAddr + aSize + sizeof(BaseAllocMetadata));

  // If end_of_cell and next_cell are in the same cache line then round up
  // next_cell.
  if ((end_of_cell & ~kCacheLineMask) == (next_cell & ~kCacheLineMask)) {
    next_cell = CACHELINE_CEILING(next_cell);
  }
  MOZ_ASSERT((next_cell % alignof(BaseAllocCell)) == 0);
  // Recalculate size.
  aSize = next_cell - sizeof(BaseAllocMetadata) - mNextAddr;

  // Make sure there's enough space for the allocation.
  if (end_of_cell + 1 > mPastAddr) {
    return nullptr;
  }

  // Make sure enough pages are committed for the new allocation.
  if (end_of_cell + 1 > mNextDecommitted) {
    uintptr_t new_next_decommitted = REAL_PAGE_CEILING(end_of_cell + 1);

    uintptr_t size_to_commit = new_next_decommitted - mNextDecommitted;
    if (!pages_commit(reinterpret_cast<void*>(mNextDecommitted),
                      size_to_commit)) {
      return nullptr;
    }

    mStats.mCommitted += size_to_commit;
    mNextDecommitted = new_next_decommitted;
  }

  BaseAllocCell* cell =
      new (reinterpret_cast<BaseAllocCell*>(mNextAddr)) BaseAllocCell(aSize);
  // mNextAddr points to where the next allocation's payload can begin, the
  // size of the metadata is already accounted for.
  mNextAddr = next_cell;
  return cell;
}

BaseAllocCell* BaseAlloc::wilderness_alloc(base_alloc_size_t aSize) {
  BaseAllocCell* cell = wilderness_alloc_inplace(aSize);
  if (cell) {
    return cell;
  }

  if (!pages_alloc(aSize)) {
    return nullptr;
  }
  return wilderness_alloc_inplace(aSize);
}

void* BaseAlloc::calloc(size_t aNumber, size_t aSize) {
  void* ret = alloc(aNumber * aSize);
  if (ret) {
    memset(ret, 0, aNumber * aSize);
  }
  return ret;
}

size_t BaseAlloc::usable_size(void* aPtr) {
  return reinterpret_cast<BaseAllocCell*>(aPtr)->Size();
}
