/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef SSLTokensCache_h_
#define SSLTokensCache_h_

#include "CertVerifier.h"  // For EVStatus
#include "mozilla/Maybe.h"
#include "mozilla/Span.h"
#include "mozilla/StaticMutex.h"
#include "mozilla/StaticPrefs_network.h"
#include "mozilla/StaticPtr.h"
#include "mozilla/OriginAttributes.h"
#include "mozilla/TimeStamp.h"
#include "nsClassHashtable.h"
#include "nsIFile.h"
#include "nsIMemoryReporter.h"
#include "nsIAsyncShutdown.h"
#include "nsIObserver.h"
#include "nsISerialEventTarget.h"
#include "nsITransportSecurityInfo.h"
#include "nsTArray.h"
#include "nsTHashMap.h"
#include "nsXULAppAPI.h"

class CommonSocketControl;
struct SslTokensPersistedRecord;

namespace mozilla {
namespace ipc {
class ByteBuf;
}
}  // namespace mozilla

namespace mozilla {
namespace net {

struct SessionCacheInfo {
  SessionCacheInfo Clone() const;

  psm::EVStatus mEVStatus = psm::EVStatus::NotEV;
  uint16_t mCertificateTransparencyStatus =
      nsITransportSecurityInfo::CERTIFICATE_TRANSPARENCY_NOT_APPLICABLE;
  nsTArray<uint8_t> mServerCertBytes;
  Maybe<nsTArray<nsTArray<uint8_t>>> mSucceededCertChainBytes;
  Maybe<bool> mIsBuiltCertChainRootBuiltInRoot;
  nsITransportSecurityInfo::OverridableErrorCategory mOverridableErrorCategory;
  Maybe<nsTArray<nsTArray<uint8_t>>> mHandshakeCertificatesBytes;
};

class SSLTokensCache : public nsIMemoryReporter,
                       public nsIObserver,
                       public nsIAsyncShutdownBlocker {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIMEMORYREPORTER
  NS_DECL_NSIOBSERVER
  NS_DECL_NSIASYNCSHUTDOWNBLOCKER

  friend class ExpirationComparator;

  static nsresult Init();
  static nsresult Shutdown();

  static nsresult Put(const nsACString& aKey, const uint8_t* aToken,
                      uint32_t aTokenLen, CommonSocketControl* aSocketControl);
  static nsresult Put(const nsACString& aKey, const uint8_t* aToken,
                      uint32_t aTokenLen, CommonSocketControl* aSocketControl,
                      PRTime aExpirationTime);
  static nsresult Get(const nsACString& aKey, nsTArray<uint8_t>& aToken,
                      SessionCacheInfo& aResult, uint64_t* aTokenId = nullptr);
  static nsresult Remove(const nsACString& aKey, uint64_t aId);
  static nsresult RemoveAll(const nsACString& aKey);
  static void Clear();
  static void RemoveByHostAndOAPattern(
      const nsACString& aHost,
      const mozilla::OriginAttributesPattern& aPattern);
  static void RemoveBySiteAndOAPattern(
      const nsACString& aSite,
      const mozilla::OriginAttributesPattern& aPattern);

  // Serialize the current cache state into STCF format for IPC transport.
  static nsTArray<uint8_t> SerializeForIPC();

  // Replace the cache and Rust shadow with STCF data received via IPC.
  static void DeserializeFromIPC(mozilla::Span<const uint8_t> aData);
  // Dispatches DeserializeFromIPC to a background thread; no-ops on empty buf.
  static void DeserializeFromIPCAsync(mozilla::ipc::ByteBuf&& aBuf);

#ifdef ENABLE_TESTS
  // Test-only helpers.
  static void TriggerWriteForTest(const nsACString& aPath);
  static void LoadForTest(const nsACString& aPath);
  static uint32_t CountForTest();
  static void PutForTest(const nsACString& aKey);
#endif

 private:
  SSLTokensCache();
  virtual ~SSLTokensCache();

  nsresult RemoveLocked(const nsACString& aKey, uint64_t aId)
      MOZ_REQUIRES(sLock);
  nsresult RemoveAllLocked(const nsACString& aKey) MOZ_REQUIRES(sLock);
  // aRemovedIds collects IDs removed from the C++ cache; the caller must call
  // ssl_tokens_cache_remove() for each after releasing sLock.
  nsresult GetLocked(const nsACString& aKey, nsTArray<uint8_t>& aToken,
                     SessionCacheInfo& aResult, uint64_t* aTokenId,
                     nsTArray<uint64_t>& aRemovedIds) MOZ_REQUIRES(sLock);

  // Evicts records until under capacity. Appends evicted IDs to aEvictedIds;
  // the caller must call ssl_tokens_cache_remove() for each after releasing
  // sLock.
  void EvictIfNecessary(nsTArray<uint64_t>& aEvictedIds) MOZ_REQUIRES(sLock);
  void LogStats() MOZ_REQUIRES(sLock);
  // Clears the C++ cache state under sLock. The caller must call
  // ssl_tokens_cache_clear() after releasing sLock.
  void ClearCacheLocked() MOZ_REQUIRES(sLock);
  // Returns true if a token for aKey with aOverridableError should be appended
  // to the Rust shadow (i.e. is not PBM and has no cert-error override).
  static bool ShouldPersistKey(const nsACString& aKey,
                               uint8_t aOverridableError);

  size_t SizeOfIncludingThis(mozilla::MallocSizeOf mallocSizeOf) const
      MOZ_REQUIRES(sLock);

  static mozilla::StaticRefPtr<SSLTokensCache> gInstance MOZ_GUARDED_BY(sLock);
  static StaticMutex sLock;
  static uint64_t sRecordId MOZ_GUARDED_BY(sLock);

  uint32_t mCacheSize MOZ_GUARDED_BY(sLock){0};

  // Persistence state (parent process only)
  nsCOMPtr<nsIFile> mBackingFile MOZ_GUARDED_BY(sLock);
  nsCOMPtr<nsISerialEventTarget> mWriteTaskQueue MOZ_GUARDED_BY(sLock);
  bool mLoadComplete MOZ_GUARDED_BY(sLock){false};
  TimeStamp mLoadStartTime MOZ_GUARDED_BY(sLock);
  // Bumped by Clear() to invalidate in-flight background loads.
  uint32_t mLoadGeneration MOZ_GUARDED_BY(sLock){0};
  void DoWrite(bool aSynchronous);
  void RegisterShutdownBlocker();
  void RemoveShutdownBlocker();
  nsCOMPtr<nsIAsyncShutdownClient> mShutdownBarrier MOZ_GUARDED_BY(sLock);
  static void OnLoadCompleteNotify(uint32_t aCount);
  // aExpectedGen: mLoadGeneration captured at load start; insertion is skipped
  // if Clear() has run since (generation mismatch).
  // Returns true if the record was inserted, false if skipped (generation
  // mismatch after a concurrent Clear()).
  static bool PutFromPersisted(const SslTokensPersistedRecord* aRec,
                               uint32_t aExpectedGen);

  struct LoadCtx {
    uint32_t loadGen;
    uint32_t count = 0;
  };
  static void LoadCallback(void* aCtx, const SslTokensPersistedRecord* aRec);
  static nsDependentCSubstring BasePartFromKey(const nsACString& aKey);
  static nsDependentCSubstring HostFromBasePart(
      const nsDependentCSubstring& aBasePart);
  static OriginAttributes OAFromPeerId(const nsACString& aPeerId);
  static void RemoveByMatchAndOAPattern(
      const nsACString& aValue, const nsACString& aSeparatedValue,
      const mozilla::OriginAttributesPattern& aPattern);

  // Removes entries matching aPredicate and returns the IDs still in the cache.
  template <typename Pred>
  nsTArray<uint64_t> RemoveMatchingLocked(Pred&& aPredicate)
      MOZ_REQUIRES(sLock);
  // Collects the mId of every record currently in the cache.
  nsTArray<uint64_t> CollectValidIdsLocked() const MOZ_REQUIRES(sLock);
  // Syncs the Rust shadow to the given ID set.
  // Must be called without sLock held.
  static void SyncRustShadow(nsTArray<uint64_t>&& aRemainingIds)
      MOZ_EXCLUDES(sLock);
  // Removes entries matching aPredicate, acquires sLock, syncs the Rust
  // shadow, then releases sLock before calling SyncRustShadow.
  template <typename Pred>
  static void RemoveMatchingAndSync(Pred&& aPredicate) MOZ_EXCLUDES(sLock);
  // FFI callback used by LoadForTest.
  static void PutFromPersistedCallback(void*,
                                       const SslTokensPersistedRecord* aRec);

  class TokenCacheRecord {
   public:
    ~TokenCacheRecord();

    uint32_t Size() const;
    void Reset();

    nsCString mKey;
    PRTime mExpirationTime = 0;
    nsTArray<uint8_t> mToken;
    SessionCacheInfo mSessionCacheInfo;
    // An unique id to identify the record. Mostly used when we want to remove a
    // record from TokenCacheEntry.
    uint64_t mId = 0;
  };

  class TokenCacheEntry {
   public:
    uint32_t Size() const;
    // Add a record into |mRecords|. To make sure |mRecords| is sorted, we
    // iterate |mRecords| everytime to find a right place to insert the new
    // record.
    void AddRecord(UniquePtr<TokenCacheRecord>&& aRecord,
                   nsTArray<TokenCacheRecord*>& aExpirationArray);
    // This function returns the first record in |mRecords|.
    const UniquePtr<TokenCacheRecord>& Get();
    UniquePtr<TokenCacheRecord> RemoveWithId(uint64_t aId);
    uint32_t RecordCount() const { return mRecords.Length(); }
    const nsTArray<UniquePtr<TokenCacheRecord>>& Records() const {
      return mRecords;
    }

   private:
    // The records in this array are ordered by the expiration time.
    nsTArray<UniquePtr<TokenCacheRecord>> mRecords;
  };

  void OnRecordDestroyed(TokenCacheRecord* aRec) MOZ_REQUIRES(sLock);
  // Inserts aRec into the cache, updates mCacheSize, and evicts if needed.
  // Returns the record ID. Appends any evicted IDs to aEvictedIds. sLock must
  // be held; caller must call ssl_tokens_cache_remove() for each evicted ID
  // after releasing sLock.
  uint64_t InsertRecordLocked(UniquePtr<TokenCacheRecord> aRec,
                              nsTArray<uint64_t>& aEvictedIds)
      MOZ_REQUIRES(sLock);

  nsClassHashtable<nsCStringHashKey, TokenCacheEntry> mTokenCacheRecords
      MOZ_GUARDED_BY(sLock);
  nsTArray<TokenCacheRecord*> mExpirationArray MOZ_GUARDED_BY(sLock);
};

}  // namespace net
}  // namespace mozilla

#endif  // SSLTokensCache_h_
