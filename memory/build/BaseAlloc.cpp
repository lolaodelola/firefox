/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "BaseAlloc.h"

#include <cstring>

#include "mozilla/Saturate.h"

#include "Globals.h"
#include "FdPrintf.h"

using namespace mozilla;

// Change this to 1 to enable some BaseAlloc logging. Useful for debugging.
#define BASE_ALLOC_LOGGING 0

// By using a macro "Log" won't collide with PHC's Log function in unified
// builds.
#if BASE_ALLOC_LOGGING
#  define Log BaseLog
static void BaseLog(const char* fmt, ...);
#else
#  define Log(...)
#endif

constinit BaseAlloc sBaseAlloc;

uintptr_t BaseAllocCell::Align(uintptr_t aPtr) {
  // In addition to assuming that kBaseQuantum, the cache line size and page
  // size are all powers of two.  We also assume that the quantum, cache
  // line size, and page size are each greater than the previous one.
  // Together these assumptions imply that each is a multiple of the
  // previous one.
  static_assert(BaseAlloc::kBaseQuantum <= kCacheLineSize);
  MOZ_ASSERT(kCacheLineSize <= gPageSize);

  uintptr_t address =
      ALIGNMENT_CEILING(aPtr, uintptr_t(BaseAlloc::kBaseQuantum));

  uintptr_t cache_line = address & ~uintptr_t(kCacheLineMask);

  if (cache_line + BaseAlloc::kBaseQuantum < address) {
    // This address would result in cells that share a cache line, move it
    // forward to the next cache line.
    address = cache_line + kCacheLineSize;
  }

  MOZ_ASSERT(aPtr <= address);
  MOZ_ASSERT((address % alignof(BaseAllocCell)) == 0);

  return address;
}

// Initialize base allocation data structures.
void BaseAlloc::Init() MOZ_REQUIRES(gInitLock) { mMutex.Init(); }

base_alloc_size_t BaseAlloc::size_round_up(base_alloc_size_t aSize) {
  return ALIGNMENT_CEILING(aSize, kBaseQuantum);
}

unsigned BaseAlloc::get_list_index_for_size(base_alloc_size_t aSize) {
  if constexpr (kBaseQuantum * 2 >= kCacheLineSize) {
    return aSize / kBaseQuantum - 1;
  } else {
    // The lambda template prevents the C++ compiler from checking this
    // branch when it's not used. This is used to avoid a compiler warning
    // when kBaseQuantum * == kCacheLineSize.
    return []<typename T>(T aSize) -> unsigned {
      // The base allocator will allocate all objects on their own
      // cache line, but if kBaseQuantum is less than two times smaller than
      // kCacheLineSize, then some object sizes are impossible, they're
      // always rounded up to ensure the next object begins on a cache line
      // boundary.  Naively this would lead to 1-in-4 free lists being
      // wasted (on x86_64) because no object will be created that size.
      // Instead the following code calculates the list index for a given
      // size.
      //
      // For any cache line multiple there are 3 possible sizes they are:
      //  + cache_multiple,
      //  + cache_multiple - kBaseQuantum
      //  + cache_multiple - kBaseQuantum*2
      //
      // The code here will map them to indexes for the free list array.

      // The minimum possible size is kBaseMinimumSize.  So start by
      // enforcing that using a saturating subtraction so that the minimum
      // becomes 0.
      aSize = (SaturateUint32(aSize) - kBaseMinimumSize).value();

      // After that subtraction dividing by the cache line size gives us
      // the group of 3 this size is in.
      unsigned cache_line = aSize / kCacheLineSize;

      // Find the remainder,
      unsigned offset = (aSize % kCacheLineSize) / kBaseQuantum;

      // Remainders 0, 1 and 2 are valid.  But any other remainder won't map
      // to a valid size, round up to the valid size.
      //
      // With an exception for offset = 3, the expression in the return
      // statement below will produce the same result for offset=3 wheather
      // we enter this branch or not so we can skip it in that case.
      if (offset > 3) {
        cache_line++;
        offset = 0;
      }

      // Find the index into the free list array.
      return cache_line * 3 + offset;
    }(aSize);
  }
}

BaseAllocMetadata* BaseAllocCell::RightMetadata() {
  uintptr_t ptr = reinterpret_cast<uintptr_t>(this) + Size() +
                  BaseAlloc::kBaseQuantum - sizeof(BaseAllocMetadata);

  MOZ_ASSERT((ptr % alignof(BaseAllocMetadata)) == 0);
  return reinterpret_cast<BaseAllocMetadata*>(ptr);
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
  cell->SetFreed();

  Log("free(%p), size: %u\n", aPtr, cell->Size());

  // Attempt to merge backwards
  BaseAllocCell* left = cell->LeftCell();
  if (left && !left->Allocated()) {
    Unlink(left);
    left->Merge(cell);
    cell = left;
  }
  // And forward
  BaseAllocCell* right = cell->RightCell();
  if (right && !right->Allocated()) {
    Unlink(right);
    cell->Merge(right);
  }

  Link(cell);
}

void* BaseAlloc::alloc(size_t aSize) {
  aSize = size_round_up(aSize);

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
    Log("alloc(%u) = %p (from free list)\n", aSize, ret);
    return ret;
  }

  ret = wilderness_alloc(aSize);
  if (ret) {
    Log("alloc(%u) = %p (from wilderness)\n", aSize, ret);
    return ret;
  }
  Log("alloc(%u) failed\n", aSize);
  return nullptr;
}

void* BaseAlloc::alloc_from_list(base_alloc_size_t aSize) {
  unsigned start_index = get_list_index_for_size(aSize);
  for (unsigned i = start_index; i < kNumFreeLists; i++) {
    if (!mFreeLists[i].isEmpty()) {
      BaseAllocCell* cell = mFreeLists[i].popFront();
      MaybeTrim(cell, aSize);

      MOZ_ASSERT(cell->Size() >= aSize);
      cell->SetAllocated();
      return cell->Ptr();
    }
  }

  // Search for the best fit in the oversize tree.
  BaseAllocCell* cell = mFreeListOversize.SearchOrNext(aSize);
  if (cell) {
    MOZ_ASSERT(cell->Size() >= aSize);
    mFreeListOversize.Remove(cell);

    MaybeTrim(cell, aSize);
    cell->SetAllocated();

    return cell->Ptr();
  }

  return nullptr;
}

void BaseAlloc::Unlink(BaseAllocCell* cell) {
  MOZ_ASSERT(!cell->Allocated());

  unsigned index = get_list_index_for_size(cell->Size());
  if (index < kNumFreeLists) {
    mFreeLists[index].remove(cell);
  } else {
    mFreeListOversize.Remove(cell);
  }
}

void BaseAlloc::Link(BaseAllocCell* cell) {
  MOZ_ASSERT(!cell->Allocated());

  // the size must conform to our classes/free lists.
  MOZ_ASSERT(cell->Size() == size_round_up(cell->Size()));

  unsigned index = get_list_index_for_size(cell->Size());
  if (index < kNumFreeLists) {
    mFreeLists[index].pushFront(cell);
  } else {
    mFreeListOversize.Insert(cell);
  }
}

bool BaseAlloc::pages_alloc(base_alloc_size_t aSize) MOZ_REQUIRES(mMutex) {
  // aSize should be non-zero and aligned already.
  MOZ_ASSERT(aSize != 0);
  MOZ_ASSERT(aSize == size_round_up(aSize));

  // Make room for the metadata on either side of this cell.
  base_alloc_size_t gross_size = kBaseQuantum * 2 + aSize;

  size_t csize = CHUNK_CEILING(gross_size);
  uintptr_t base_pages =
      reinterpret_cast<uintptr_t>(chunk_alloc(csize, kChunkSize, true));
  if (base_pages == 0) {
    return false;
  }
  mPastAddr = base_pages + csize;

  // Set mNext so that there's enough space for the first cell's metadata.
  mNextAddr = base_pages + kBaseQuantum;
  MOZ_ASSERT(mNextAddr <= mPastAddr);
  // It's already correctly aligned
  MOZ_ASSERT(mNextAddr == BaseAllocCell::Align(mNextAddr));

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

  // The first byte in the next cell, skip over the metadata between cells.
  uintptr_t next_cell =
      BaseAllocCell::Align(mNextAddr + aSize + sizeof(BaseAllocMetadata));

  // Recalculate size.
  aSize = next_cell - kBaseQuantum - mNextAddr;
  MOZ_ASSERT(aSize == size_round_up(aSize));

  // Make sure there's enough space for the allocation.
  if (next_cell > mPastAddr) {
    return nullptr;
  }

  // Make sure enough pages are committed for the new allocation.
  if (next_cell > mNextDecommitted) {
    uintptr_t new_next_decommitted = REAL_PAGE_CEILING(next_cell);

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
  cell->SetAllocated();
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

void BaseAllocCell::SetSize(base_alloc_size_t aSize) {
  MOZ_ASSERT(aSize == BaseAlloc::size_round_up(aSize));

  // Set the left metadata's size first so it can be used to get the
  // right metadata's address.
  LeftMetadata()->mRightSize = aSize;

  // Now it's safe to set the right metadata's size.  Note that both the
  // old-right metadata, and the new metadata's right size are left untouched.
  RightMetadata()->mLeftSize = aSize;
}

void BaseAllocCell::ClearPayload() { memset(&mListElem, 0, sizeof(mListElem)); }

BaseAllocCell* BaseAllocCell::LeftCell() {
  base_alloc_size_t left_cell_size = LeftMetadata()->mLeftSize;
  if (!left_cell_size) {
    return nullptr;
  }

  BaseAllocCell* left = reinterpret_cast<BaseAllocCell*>(
      reinterpret_cast<uintptr_t>(this) - BaseAlloc::kBaseQuantum -
      left_cell_size);

  MOZ_ASSERT(left->RightMetadata() == LeftMetadata());

  return left;
}

BaseAllocCell* BaseAllocCell::RightCell() {
  base_alloc_size_t right_size = RightMetadata()->mRightSize;
  if (right_size == 0) {
    return nullptr;
  }

  BaseAllocCell* right = reinterpret_cast<BaseAllocCell*>(RightCellRaw());

  MOZ_ASSERT(RightMetadata() == right->LeftMetadata());

  return right;
}

uintptr_t BaseAllocCell::RightCellRaw() {
  return reinterpret_cast<uintptr_t>(this) + Size() + BaseAlloc::kBaseQuantum;
}

void BaseAllocCell::Merge(BaseAllocCell* aOther) {
  // aOther must be after this, we can check by comparing what they each
  // think their metadata is.
  MOZ_ASSERT(RightMetadata() == aOther->LeftMetadata());
  base_alloc_size_t new_size =
      Size() + aOther->Size() + BaseAlloc::kBaseQuantum;

  Log("Merge %p (size %u) with %p (size %u) -> size %u\n", this, Size(), aOther,
      aOther->Size(), new_size);

#ifdef MOZ_DEBUG
  BaseAllocMetadata* right_metadata = aOther->RightMetadata();
#endif
  // Check for overflow.
  MOZ_ASSERT(new_size > this->Size() && new_size > aOther->Size());

  BaseAllocMetadata* old_metadata = RightMetadata();
  SetSize(new_size);

  MOZ_ASSERT(RightMetadata() == right_metadata);

  // Clearing the old metadata may make debugging easier.
  old_metadata->Clear();
}

uintptr_t BaseAllocCell::CanSplit(base_alloc_size_t aSizeReq) {
  if (aSizeReq + BaseAlloc::kBaseQuantum + sizeof(BaseAllocCell) >= Size()) {
    // Insufficient size.
    return 0;
  }

  // Rather than use the requested size directly for the first cell, start
  // with the requested size then align the next cell and check if it still
  // leaves enough room after alignment.

  uintptr_t next_addr = Align(reinterpret_cast<uintptr_t>(this) + aSizeReq +
                              sizeof(BaseAllocMetadata));

  if (next_addr + BaseAlloc::kBaseMinimumSize >
      reinterpret_cast<uintptr_t>(RightMetadata())) {
    return 0;
  }

  return next_addr;
}

void BaseAlloc::MaybeTrim(BaseAllocCell* aCell,
                          base_alloc_size_t aSizeRequest) {
  uintptr_t new_addr = aCell->CanSplit(aSizeRequest);
  if (!new_addr) {
    return;
  }

  BaseAllocCell* next = aCell->Split(new_addr);
  MOZ_ASSERT(next);
  Link(next);
}

BaseAllocCell* BaseAllocCell::Split(uintptr_t aNewAddr) {
#ifdef MOZ_DEBUG
  BaseAllocMetadata* last_metadata = RightMetadata();
#endif
  base_alloc_size_t old_size = Size();
  base_alloc_size_t new_size =
      aNewAddr - BaseAlloc::kBaseQuantum - reinterpret_cast<uintptr_t>(this);
  SetSize(new_size);

  // This must use NextCellRaw and cast the result, using NextCell would run
  // assertions that would fail.
  BaseAllocCell* right = new (reinterpret_cast<BaseAllocCell*>(RightCellRaw()))
      BaseAllocCell(old_size - new_size - BaseAlloc::kBaseQuantum);

  Log("Split %p (size %u) -> (size %u) and %p (size %u)\n", this, old_size,
      Size(), right, right->Size());

  // Prove that the alignment code above is correct.
  MOZ_ASSERT(new_size == BaseAlloc::size_round_up(new_size));
  MOZ_ASSERT(right->Size() == BaseAlloc::size_round_up(right->Size()));
  MOZ_ASSERT(this->RightMetadata() == right->LeftMetadata());
  MOZ_ASSERT(right->RightMetadata() == last_metadata);

  return right;
}

#if BASE_ALLOC_LOGGING
static size_t GetPid() { return size_t(getpid()); }

static void BaseLog(const char* fmt, ...) {
#  ifdef _WIN32
#    define LOG_STDERR GetStdHandle(STD_ERROR_HANDLE)
#  else
#    define LOG_STDERR 2
#  endif

  char buf[256];
  size_t pos = SNPrintf(buf, sizeof(buf), "BaseAlloc[%zu] ", GetPid());
  va_list vargs;
  va_start(vargs, fmt);
  pos += VSNPrintf(&buf[pos], sizeof(buf) - pos, fmt, vargs);
  MOZ_ASSERT(pos < sizeof(buf));
  va_end(vargs);

  FdPuts(LOG_STDERR, buf, pos);
}
#endif  // BASE_ALLOC_LOGGING

#undef Log
