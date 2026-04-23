/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "SSLTokensCache.h"

#include "mozilla/Components.h"

#include "CertVerifier.h"
#include "CommonSocketControl.h"
#include "TransportSecurityInfo.h"
#include "mozilla/ArrayAlgorithm.h"
#include "mozilla/glean/NetwerkMetrics.h"
#include "mozilla/Logging.h"
#include "mozilla/Preferences.h"
#include "mozilla/OriginAttributes.h"
#include "mozilla/Services.h"
#include "mozilla/StaticPrefs_privacy.h"
#include "nsAppDirectoryServiceDefs.h"
#include "nsDirectoryServiceUtils.h"
#include "nsIOService.h"
#include "nsIEventTarget.h"
#include "nsThreadUtils.h"
#include "nsIObserverService.h"
#include "prtime.h"
#include "ssl.h"
#include "sslexp.h"
#include "mozilla/net/ssl_tokens_cache.h"
#include "mozilla/ipc/ByteBuf.h"
#include "mozilla/net/SocketProcessChild.h"
#include "mozilla/net/SocketProcessParent.h"

namespace mozilla {
namespace net {

static LazyLogModule gSSLTokensCacheLog("SSLTokensCache");
#undef LOG
#define LOG(args) MOZ_LOG(gSSLTokensCacheLog, mozilla::LogLevel::Debug, args)
#undef LOG5_ENABLED
#define LOG5_ENABLED() \
  MOZ_LOG_TEST(mozilla::net::gSSLTokensCacheLog, mozilla::LogLevel::Verbose)

class ExpirationComparator {
 public:
  bool Equals(SSLTokensCache::TokenCacheRecord* a,
              SSLTokensCache::TokenCacheRecord* b) const {
    return a->mExpirationTime == b->mExpirationTime;
  }
  bool LessThan(SSLTokensCache::TokenCacheRecord* a,
                SSLTokensCache::TokenCacheRecord* b) const {
    return a->mExpirationTime < b->mExpirationTime;
  }
};

SessionCacheInfo SessionCacheInfo::Clone() const {
  SessionCacheInfo result;
  result.mEVStatus = mEVStatus;
  result.mCertificateTransparencyStatus = mCertificateTransparencyStatus;
  result.mServerCertBytes = mServerCertBytes.Clone();
  result.mSucceededCertChainBytes =
      mSucceededCertChainBytes
          ? Some(TransformIntoNewArray(
                *mSucceededCertChainBytes,
                [](const auto& element) { return element.Clone(); }))
          : Nothing();
  result.mIsBuiltCertChainRootBuiltInRoot = mIsBuiltCertChainRootBuiltInRoot;
  result.mOverridableErrorCategory = mOverridableErrorCategory;
  result.mHandshakeCertificatesBytes =
      mHandshakeCertificatesBytes
          ? Some(TransformIntoNewArray(
                *mHandshakeCertificatesBytes,
                [](const auto& element) { return element.Clone(); }))
          : Nothing();
  return result;
}

StaticRefPtr<SSLTokensCache> SSLTokensCache::gInstance;
StaticMutex SSLTokensCache::sLock;
uint64_t SSLTokensCache::sRecordId = 0;

SSLTokensCache::TokenCacheRecord::~TokenCacheRecord() {
  if (!gInstance) {
    return;
  }

  gInstance->OnRecordDestroyed(this);
}

uint32_t SSLTokensCache::TokenCacheRecord::Size() const {
  uint32_t size = mToken.Length() + sizeof(mSessionCacheInfo.mEVStatus) +
                  sizeof(mSessionCacheInfo.mCertificateTransparencyStatus) +
                  mSessionCacheInfo.mServerCertBytes.Length() +
                  sizeof(mSessionCacheInfo.mIsBuiltCertChainRootBuiltInRoot) +
                  sizeof(mSessionCacheInfo.mOverridableErrorCategory);
  if (mSessionCacheInfo.mSucceededCertChainBytes) {
    for (const auto& cert : mSessionCacheInfo.mSucceededCertChainBytes.ref()) {
      size += cert.Length();
    }
  }
  if (mSessionCacheInfo.mHandshakeCertificatesBytes) {
    for (const auto& cert :
         mSessionCacheInfo.mHandshakeCertificatesBytes.ref()) {
      size += cert.Length();
    }
  }
  return size;
}

void SSLTokensCache::TokenCacheRecord::Reset() {
  mToken.Clear();
  mExpirationTime = 0;
  mSessionCacheInfo.mEVStatus = psm::EVStatus::NotEV;
  mSessionCacheInfo.mCertificateTransparencyStatus =
      nsITransportSecurityInfo::CERTIFICATE_TRANSPARENCY_NOT_APPLICABLE;
  mSessionCacheInfo.mServerCertBytes.Clear();
  mSessionCacheInfo.mSucceededCertChainBytes.reset();
  mSessionCacheInfo.mIsBuiltCertChainRootBuiltInRoot.reset();
  mSessionCacheInfo.mOverridableErrorCategory =
      nsITransportSecurityInfo::OverridableErrorCategory::ERROR_UNSET;
  mSessionCacheInfo.mHandshakeCertificatesBytes.reset();
}

uint32_t SSLTokensCache::TokenCacheEntry::Size() const {
  uint32_t size = 0;
  for (const auto& rec : mRecords) {
    size += rec->Size();
  }
  return size;
}

void SSLTokensCache::TokenCacheEntry::AddRecord(
    UniquePtr<SSLTokensCache::TokenCacheRecord>&& aRecord,
    nsTArray<TokenCacheRecord*>& aExpirationArray) {
  if (mRecords.Length() ==
      StaticPrefs::network_ssl_tokens_cache_records_per_entry()) {
    aExpirationArray.RemoveElement(mRecords[0].get());
    mRecords.RemoveElementAt(0);
  }

  aExpirationArray.AppendElement(aRecord.get());
  for (int32_t i = mRecords.Length() - 1; i >= 0; --i) {
    if (aRecord->mExpirationTime > mRecords[i]->mExpirationTime) {
      mRecords.InsertElementAt(i + 1, std::move(aRecord));
      return;
    }
  }
  mRecords.InsertElementAt(0, std::move(aRecord));
}

UniquePtr<SSLTokensCache::TokenCacheRecord>
SSLTokensCache::TokenCacheEntry::RemoveWithId(uint64_t aId) {
  for (int32_t i = mRecords.Length() - 1; i >= 0; --i) {
    if (mRecords[i]->mId == aId) {
      UniquePtr<TokenCacheRecord> record = std::move(mRecords[i]);
      mRecords.RemoveElementAt(i);
      return record;
    }
  }
  return nullptr;
}

const UniquePtr<SSLTokensCache::TokenCacheRecord>&
SSLTokensCache::TokenCacheEntry::Get() {
  return mRecords[0];
}

NS_IMPL_ISUPPORTS(SSLTokensCache, nsIMemoryReporter, nsIObserver,
                  nsIAsyncShutdownBlocker)

template <typename Pred>
nsTArray<uint64_t> SSLTokensCache::RemoveMatchingLocked(Pred&& aPredicate) {
  sLock.AssertCurrentThreadOwns();
  AutoTArray<nsCString, 4> keysToRemove;
  for (const auto& entry : mTokenCacheRecords) {
    if (aPredicate(entry.GetKey())) {
      keysToRemove.AppendElement(entry.GetKey());
    }
  }
  for (const auto& key : keysToRemove) {
    (void)RemoveAllLocked(key);
  }
  return CollectValidIdsLocked();
}

nsTArray<uint64_t> SSLTokensCache::CollectValidIdsLocked() const {
  sLock.AssertCurrentThreadOwns();
  nsTArray<uint64_t> ids;
  for (const auto& entry : mTokenCacheRecords.Values()) {
    for (const auto& rec : entry->Records()) {
      ids.AppendElement(rec->mId);
    }
  }
  return ids;
}

// static
void SSLTokensCache::PutFromPersistedCallback(
    void* aCtx, const SslTokensPersistedRecord* aRec) {
  (void)PutFromPersisted(aRec, *static_cast<uint32_t*>(aCtx));
}

// static
void SSLTokensCache::LoadCallback(void* aCtx,
                                  const SslTokensPersistedRecord* aRec) {
  auto* ctx = static_cast<LoadCtx*>(aCtx);
  if (PutFromPersisted(aRec, ctx->loadGen)) {
    ctx->count++;
  }
}

// static
void SSLTokensCache::SyncRustShadow(nsTArray<uint64_t>&& aRemainingIds) {
  ssl_tokens_cache_retain_only(&aRemainingIds);
}

void SSLTokensCache::ClearCacheLocked() {
  sLock.AssertCurrentThreadOwns();
  mLoadGeneration++;
  mExpirationArray.Clear();
  mTokenCacheRecords.Clear();
  mCacheSize = 0;
}

// static
nsTArray<uint8_t> SSLTokensCache::SerializeForIPC() {
  nsTArray<uint64_t> ids;
  {
    StaticMutexAutoLock lock(sLock);
    if (!gInstance) {
      return {};
    }
    ids = gInstance->CollectValidIdsLocked();
  }
  if (ids.IsEmpty()) {
    return {};
  }
  nsTArray<uint8_t> out;
  // Note: ssl_tokens_cache_serialize acquires the Rust STATE mutex separately.
  // A concurrent Put() or Get() between the two lock acquisitions may cause the
  // snapshot to be slightly stale (a new token added or consumed token still
  // included), which is acceptable — this path provides eventual consistency,
  // not a transactional snapshot.
  ssl_tokens_cache_serialize(&ids, &out);
  return out;
}

// static
void SSLTokensCache::DeserializeFromIPC(Span<const uint8_t> aData) {
  if (aData.IsEmpty()) {
    return;
  }
  // Clear the C++ cache first (under sLock), then clear the Rust shadow
  // outside the lock. This order ensures a concurrent Put() cannot lose its
  // C++ entry between the two clears. The mLoadGeneration bump in
  // ClearCacheLocked invalidates any in-flight PutFromPersisted dispatches.
  uint32_t loadGen = 0;
  {
    StaticMutexAutoLock lock(sLock);
    if (!gInstance) {
      return;
    }
    gInstance->ClearCacheLocked();
    loadGen = gInstance->mLoadGeneration;
  }
  ssl_tokens_cache_clear();
  // callback is invoked synchronously within ssl_tokens_cache_deserialize_ipc,
  // so &loadGen remains valid for the entire call.
  ssl_tokens_cache_deserialize_ipc(aData.data(), aData.Length(), PR_Now(),
                                   PutFromPersistedCallback, &loadGen);
}

// static
void SSLTokensCache::DeserializeFromIPCAsync(mozilla::ipc::ByteBuf&& aBuf) {
  if (aBuf.mLen == 0) {
    return;
  }
  NS_DispatchBackgroundTask(NS_NewRunnableFunction(
      "SSLTokensCache::DeserializeFromIPCAsync", [buf = std::move(aBuf)]() {
        DeserializeFromIPC(Span(buf.mData, buf.mLen));
      }));
}

// static
nsDependentCSubstring SSLTokensCache::BasePartFromKey(const nsACString& aKey) {
  int32_t caretPos = aKey.FindChar('^');
  return nsDependentCSubstring(
      aKey, 0, caretPos == kNotFound ? aKey.Length() : caretPos);
}

// static
// Extracts the host from a key's base part ("host:port" or "prefix:host:port").
// Returns an empty string if no colon is found.
nsDependentCSubstring SSLTokensCache::HostFromBasePart(
    const nsDependentCSubstring& aBasePart) {
  int32_t lastColon = aBasePart.RFindChar(':');
  if (lastColon == kNotFound) {
    return nsDependentCSubstring();
  }
  return nsDependentCSubstring(aBasePart, 0, lastColon);
}

// static
OriginAttributes SSLTokensCache::OAFromPeerId(const nsACString& aPeerId) {
  OriginAttributes oa;
  int32_t caretPos = aPeerId.FindChar('^');
  if (caretPos != kNotFound) {
    nsAutoCString suffix(Substring(aPeerId, caretPos + 1));
    (void)oa.PopulateFromSuffix(suffix);
  }
  return oa;
}

// static
nsresult SSLTokensCache::Init() {
  MOZ_ASSERT(NS_IsMainThread());
  nsCString backgroundLoadPath;
  uint32_t loadGen = 0;
  {
    StaticMutexAutoLock lock(sLock);

    // SSLTokensCache is used in both the parent process and the socket process.
    // The socket process runs TLS handshakes and holds the live token cache;
    // the parent process holds the persistence layer (disk I/O) and receives
    // periodic token updates from the socket process via IPC.
    // Some xpcshell tests also use sockets directly in the parent process.
    if (!(XRE_IsSocketProcess() || XRE_IsParentProcess())) {
      return NS_OK;
    }

    MOZ_ASSERT(!gInstance);

    gInstance = new SSLTokensCache();

    RegisterWeakMemoryReporter(gInstance);

    if (!StaticPrefs::network_ssl_tokens_cache_persistence()) {
      return NS_OK;
    }

    // Both the parent and the socket process register for idle/background
    // notifications to trigger DoWrite():
    //   Parent: DoWrite() writes to disk.
    //   Socket: DoWrite() serializes and sends the cache to the parent via IPC.
    nsCOMPtr<nsIObserverService> obs = mozilla::services::GetObserverService();
    if (obs) {
      obs->AddObserver(gInstance, "application-background", false);
      obs->AddObserver(gInstance, "idle-daily", false);
    }

    if (!XRE_IsParentProcess()) {
      return NS_OK;
    }

    nsCOMPtr<nsIFile> profileDir;
    if (NS_FAILED(NS_GetSpecialDirectory(NS_APP_USER_PROFILE_50_DIR,
                                         getter_AddRefs(profileDir)))) {
      return NS_OK;
    }
    profileDir->Clone(getter_AddRefs(gInstance->mBackingFile));
    gInstance->mBackingFile->AppendNative("ssl_tokens_cache.bin"_ns);

    nsCOMPtr<nsISerialEventTarget> writeQueue;
    NS_CreateBackgroundTaskQueue("SslTokensCachePersist",
                                 getter_AddRefs(writeQueue));
    gInstance->mWriteTaskQueue = writeQueue;

    // Register an async shutdown blocker on ProfileBeforeChange so the cache
    // is written off the main thread before the profile is torn down.
    // SSLTokensCache::Shutdown() (called by nsIOService) is the fallback for
    // environments (e.g. xpcshell tests) where the async shutdown service is
    // unavailable.
    nsCOMPtr<nsIAsyncShutdownService> svc =
        components::AsyncShutdown::Service();
    if (svc) {
      nsCOMPtr<nsIAsyncShutdownClient> client;
      svc->GetProfileBeforeChange(getter_AddRefs(client));
      if (client) {
        // mShutdownBarrier is guarded by sLock; assign under the lock.
        gInstance->mShutdownBarrier = client;
        client->AddBlocker(gInstance, NS_LITERAL_STRING_FROM_CSTRING(__FILE__),
                           __LINE__, u""_ns);
      }
    }

    gInstance->mLoadStartTime = TimeStamp::Now();
    loadGen = gInstance->mLoadGeneration;

    nsAutoString widePath;
    gInstance->mBackingFile->GetPath(widePath);
    backgroundLoadPath = NS_ConvertUTF16toUTF8(widePath);
  }  // sLock released before dispatching

  NS_DispatchBackgroundTask(
      NS_NewRunnableFunction("SSLTokensCache::LoadPersisted",
                             [path = std::move(backgroundLoadPath), loadGen]() {
                               nsAutoLowPriorityIO lowPriorityIO;

                               SSLTokensCache::LoadCtx ctx{loadGen};
                               ssl_tokens_cache_read(
                                   &path, PR_Now(),
                                   SSLTokensCache::LoadCallback, &ctx);
                               SSLTokensCache::OnLoadCompleteNotify(ctx.count);
                             }),
      NS_DISPATCH_EVENT_MAY_BLOCK);

  return NS_OK;
}

// static
nsresult SSLTokensCache::Shutdown() {
  RefPtr<SSLTokensCache> instance;
  nsCOMPtr<nsIObserverService> obs;
  {
    StaticMutexAutoLock lock(sLock);

    if (!gInstance) {
      return NS_ERROR_UNEXPECTED;
    }

    UnregisterWeakMemoryReporter(gInstance);
    instance = gInstance;
    obs = mozilla::services::GetObserverService();
    // Do not null gInstance yet — DoWrite needs it to collect valid IDs.
  }

#ifdef ENABLE_TESTS
  // Synchronous fallback write for test environments that lack the
  // async-shutdown service and thus never trigger BlockShutdown(). Guard on
  // mWriteTaskQueue being null so we don't race with a BlockShutdown write
  // task in environments that do have the async-shutdown service.
  // mWriteTaskQueue is guarded by sLock; check it under a fresh lock scope
  // since DoWrite takes sLock internally.
  if ([&] {
        StaticMutexAutoLock lock(sLock);
        return !instance->mWriteTaskQueue;
      }()) {
    instance->DoWrite(true);
  }
#endif

  {
    StaticMutexAutoLock lock(sLock);
    gInstance = nullptr;
  }

  if (obs && instance) {
    obs->RemoveObserver(instance, "application-background");
    obs->RemoveObserver(instance, "idle-daily");
  }
  if (instance) {
    instance->RemoveShutdownBlocker();
  }
  return NS_OK;
}

SSLTokensCache::SSLTokensCache() { LOG(("SSLTokensCache::SSLTokensCache")); }

SSLTokensCache::~SSLTokensCache() { LOG(("SSLTokensCache::~SSLTokensCache")); }

// static
nsresult SSLTokensCache::Put(const nsACString& aKey, const uint8_t* aToken,
                             uint32_t aTokenLen,
                             CommonSocketControl* aSocketControl) {
  PRTime expirationTime;
  SSLResumptionTokenInfo tokenInfo;
  if (SSL_GetResumptionTokenInfo(aToken, aTokenLen, &tokenInfo,
                                 sizeof(tokenInfo)) != SECSuccess) {
    LOG(("  cannot get expiration time from the token, NSS error %d",
         PORT_GetError()));
    return NS_ERROR_FAILURE;
  }

  expirationTime = tokenInfo.expirationTime;
  SSL_DestroyResumptionTokenInfo(&tokenInfo);

  return Put(aKey, aToken, aTokenLen, aSocketControl, expirationTime);
}

// static
nsresult SSLTokensCache::Put(const nsACString& aKey, const uint8_t* aToken,
                             uint32_t aTokenLen,
                             CommonSocketControl* aSocketControl,
                             PRTime aExpirationTime) {
  LOG(("SSLTokensCache::Put [key=%s, tokenLen=%u]",
       PromiseFlatCString(aKey).get(), aTokenLen));

  if (!aSocketControl) {
    return NS_ERROR_FAILURE;
  }

  nsCOMPtr<nsITransportSecurityInfo> securityInfo;
  nsresult rv = aSocketControl->GetSecurityInfo(getter_AddRefs(securityInfo));
  if (NS_FAILED(rv)) {
    return rv;
  }

  nsCOMPtr<nsIX509Cert> cert;
  securityInfo->GetServerCert(getter_AddRefs(cert));
  if (!cert) {
    return NS_ERROR_FAILURE;
  }

  nsTArray<uint8_t> certBytes;
  rv = cert->GetRawDER(certBytes);
  if (NS_FAILED(rv)) {
    return rv;
  }

  Maybe<nsTArray<nsTArray<uint8_t>>> succeededCertChainBytes;
  nsTArray<RefPtr<nsIX509Cert>> succeededCertArray;
  rv = securityInfo->GetSucceededCertChain(succeededCertArray);
  if (NS_FAILED(rv)) {
    return rv;
  }

  auto getRawDerAll = [](nsTArray<RefPtr<nsIX509Cert>>& aCerts)
      -> Result<nsTArray<nsTArray<uint8_t>>, nsresult> {
    return TransformIntoNewArrayAbortOnErr(
        aCerts,
        [](const RefPtr<nsIX509Cert>& aCert)
            -> Result<nsTArray<uint8_t>, nsresult> {
          nsTArray<uint8_t> raw;
          MOZ_TRY(aCert->GetRawDER(raw));
          return std::move(raw);
        },
        fallible);
  };

  Maybe<bool> isBuiltCertChainRootBuiltInRoot;
  if (!succeededCertArray.IsEmpty()) {
    auto result = getRawDerAll(succeededCertArray);
    if (result.isErr()) return result.unwrapErr();
    succeededCertChainBytes.emplace(result.unwrap());

    bool builtInRoot = false;
    rv = securityInfo->GetIsBuiltCertChainRootBuiltInRoot(&builtInRoot);
    if (NS_FAILED(rv)) {
      return rv;
    }
    isBuiltCertChainRootBuiltInRoot.emplace(builtInRoot);
  }

  bool isEV;
  rv = securityInfo->GetIsExtendedValidation(&isEV);
  if (NS_FAILED(rv)) {
    return rv;
  }

  uint16_t certificateTransparencyStatus;
  rv = securityInfo->GetCertificateTransparencyStatus(
      &certificateTransparencyStatus);
  if (NS_FAILED(rv)) {
    return rv;
  }

  nsITransportSecurityInfo::OverridableErrorCategory overridableErrorCategory;
  rv = securityInfo->GetOverridableErrorCategory(&overridableErrorCategory);
  if (NS_FAILED(rv)) {
    return rv;
  }

  Maybe<nsTArray<nsTArray<uint8_t>>> handshakeCertificatesBytes;
  nsTArray<RefPtr<nsIX509Cert>> handshakeCertificates;
  rv = securityInfo->GetHandshakeCertificates(handshakeCertificates);
  if (NS_FAILED(rv)) {
    return rv;
  }
  if (!handshakeCertificates.IsEmpty()) {
    auto result = getRawDerAll(handshakeCertificates);
    if (result.isErr()) return result.unwrapErr();
    handshakeCertificatesBytes.emplace(result.unwrap());
  }

  uint64_t recordId = 0;
  AutoTArray<uint64_t, 2> evictedIds;

  {
    StaticMutexAutoLock lock(sLock);

    if (!gInstance) {
      LOG(("  service not initialized"));
      return NS_ERROR_NOT_INITIALIZED;
    }

    auto cloneChain = [](const Maybe<nsTArray<nsTArray<uint8_t>>>& aSrc)
        -> Maybe<nsTArray<nsTArray<uint8_t>>> {
      if (aSrc.isNothing()) return Nothing();
      return Some(TransformIntoNewArray(
          aSrc.ref(), [](const auto& element) { return element.Clone(); }));
    };

    auto makeRecord = [&]() MOZ_REQUIRES(sLock) {
      auto rec = MakeUnique<TokenCacheRecord>();
      rec->mKey = aKey;
      rec->mExpirationTime = aExpirationTime;
      MOZ_ASSERT(rec->mToken.IsEmpty());
      rec->mToken.AppendElements(aToken, aTokenLen);
      rec->mSessionCacheInfo.mServerCertBytes = std::move(certBytes);
      rec->mSessionCacheInfo.mSucceededCertChainBytes =
          cloneChain(succeededCertChainBytes);
      if (isEV) {
        rec->mSessionCacheInfo.mEVStatus = psm::EVStatus::EV;
      }
      rec->mSessionCacheInfo.mCertificateTransparencyStatus =
          certificateTransparencyStatus;
      rec->mSessionCacheInfo.mIsBuiltCertChainRootBuiltInRoot =
          isBuiltCertChainRootBuiltInRoot;
      rec->mSessionCacheInfo.mOverridableErrorCategory =
          overridableErrorCategory;
      rec->mSessionCacheInfo.mHandshakeCertificatesBytes =
          cloneChain(handshakeCertificatesBytes);
      return rec;
    };

    recordId = gInstance->InsertRecordLocked(makeRecord(), evictedIds);
    gInstance->LogStats();

  }  // sLock released

  for (uint64_t id : evictedIds) {
    ssl_tokens_cache_remove(id);
  }

  if (recordId != 0 &&
      ShouldPersistKey(aKey, static_cast<uint8_t>(overridableErrorCategory))) {
    SslTokensPersistedRecord rec{};
    rec.id = recordId;
    rec.key = aKey;
    rec.expiration_time = static_cast<int64_t>(aExpirationTime);
    rec.token = aToken;
    rec.token_len = aTokenLen;
    rec.ev_status = isEV ? 1 : 0;
    rec.ct_status = certificateTransparencyStatus;
    rec.overridable_error = static_cast<uint8_t>(overridableErrorCategory);
    ssl_tokens_cache_append(&rec);
  }

  return NS_OK;
}

// static
// Retrieves a TLS session resumption token from the cache.
//
// Behavior:
// - Searches for cached tokens matching aKey (typically a peer ID that includes
//   hostname, port, and TLS flags)
// - Multiple tokens may exist per key (stored in a pool); this method retrieves
//   and removes the first non-expired token
// - Expired tokens are automatically discarded during lookup
// - Returns NS_ERROR_NOT_AVAILABLE if no valid token is found
//
// Parameters:
// - aKey: Cache key identifying the connection (peer ID)
// - aToken: [out] The TLS session resumption token bytes
// - aResult: [out] Associated session info (certificates, EV status, CT status)
// - aTokenId: [out, optional] Unique ID of the retrieved token (for later
// removal)
//
// Note: This is a destructive read - the token is removed from the cache after
// retrieval to prevent reuse, as TLS session tickets are typically single-use.
nsresult SSLTokensCache::Get(const nsACString& aKey, nsTArray<uint8_t>& aToken,
                             SessionCacheInfo& aResult, uint64_t* aTokenId) {
  AutoTArray<uint64_t, 2> removedIds;
  nsresult rv;
  {
    StaticMutexAutoLock lock(sLock);

    LOG(("SSLTokensCache::Get [key=%s]", PromiseFlatCString(aKey).get()));

    if (!gInstance) {
      LOG(("  service not initialized"));
      return NS_ERROR_NOT_INITIALIZED;
    }

    rv = gInstance->GetLocked(aKey, aToken, aResult, aTokenId, removedIds);
  }
  for (uint64_t id : removedIds) {
    ssl_tokens_cache_remove(id);
  }
  return rv;
}

nsresult SSLTokensCache::GetLocked(const nsACString& aKey,
                                   nsTArray<uint8_t>& aToken,
                                   SessionCacheInfo& aResult,
                                   uint64_t* aTokenId,
                                   nsTArray<uint64_t>& aRemovedIds) {
  sLock.AssertCurrentThreadOwns();

  if (!mLoadComplete && mBackingFile) {
    LOG(("SSLTokensCache::GetLocked: connection before load complete"));
    mozilla::glean::network::ssl_token_cache_early_connections.Add(1);
  }

  TokenCacheEntry* cacheEntry = nullptr;

  if (mTokenCacheRecords.Get(aKey, &cacheEntry)) {
    if (cacheEntry->RecordCount() == 0) {
      MOZ_ASSERT(false, "Found a cacheEntry with no records");
      mTokenCacheRecords.Remove(aKey);
      return NS_ERROR_NOT_AVAILABLE;
    }

    PRTime now = PR_Now();

    while (cacheEntry->RecordCount() > 0) {
      const UniquePtr<TokenCacheRecord>& rec = cacheEntry->Get();

      if (rec->mExpirationTime > now) {
        uint64_t id = rec->mId;
        uint32_t size = rec->Size();
        UniquePtr<TokenCacheRecord> owned = cacheEntry->RemoveWithId(id);
        aToken = std::move(owned->mToken);
        aResult = std::move(owned->mSessionCacheInfo);
        if (aTokenId) {
          *aTokenId = id;
        }
        mCacheSize -= size;
        if (cacheEntry->RecordCount() == 0) {
          mTokenCacheRecords.Remove(aKey);
        }
        aRemovedIds.AppendElement(id);
        mozilla::glean::network::ssl_token_cache_hits.Get("hit"_ns).Add(1);
        LOG(("SSLTokensCache::GetLocked: hit [key=%s, load_complete=%s]",
             PromiseFlatCString(aKey).get(), mLoadComplete ? "yes" : "no"));
        return NS_OK;
      }

      LOG(("  skipping expired token [expirationTime=%" PRId64 ", now=%" PRId64
           "]",
           rec->mExpirationTime, now));
      mozilla::glean::network::ssl_token_cache_expired.Add(1);
      uint64_t expiredId = rec->mId;
      mCacheSize -= rec->Size();
      cacheEntry->RemoveWithId(expiredId);
      aRemovedIds.AppendElement(expiredId);
    }

    mTokenCacheRecords.Remove(aKey);
  }

  LOG(("  token not found"));
  mozilla::glean::network::ssl_token_cache_hits.Get("miss"_ns).Add(1);
  return NS_ERROR_NOT_AVAILABLE;
}

// static
nsresult SSLTokensCache::Remove(const nsACString& aKey, uint64_t aId) {
  StaticMutexAutoLock lock(sLock);

  LOG(("SSLTokensCache::Remove [key=%s]", PromiseFlatCString(aKey).get()));

  if (!gInstance) {
    LOG(("  service not initialized"));
    return NS_ERROR_NOT_INITIALIZED;
  }

  return gInstance->RemoveLocked(aKey, aId);
}

nsresult SSLTokensCache::RemoveLocked(const nsACString& aKey, uint64_t aId) {
  sLock.AssertCurrentThreadOwns();

  LOG(("SSLTokensCache::RemoveLocked [key=%s, id=%" PRIu64 "]",
       PromiseFlatCString(aKey).get(), aId));

  TokenCacheEntry* cacheEntry;
  if (!mTokenCacheRecords.Get(aKey, &cacheEntry)) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  UniquePtr<TokenCacheRecord> rec = cacheEntry->RemoveWithId(aId);
  if (!rec) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  mCacheSize -= rec->Size();
  if (cacheEntry->RecordCount() == 0) {
    mTokenCacheRecords.Remove(aKey);
  }

  // Release the record immediately, so mExpirationArray can be also updated.
  rec = nullptr;

  LogStats();

  return NS_OK;
}

// static
nsresult SSLTokensCache::RemoveAll(const nsACString& aKey) {
  AutoTArray<uint64_t, 10> removedIds;
  nsresult rv;
  {
    StaticMutexAutoLock lock(sLock);

    LOG(("SSLTokensCache::RemoveAll [key=%s]", PromiseFlatCString(aKey).get()));

    if (!gInstance) {
      LOG(("  service not initialized"));
      return NS_ERROR_NOT_INITIALIZED;
    }

    TokenCacheEntry* cacheEntry = nullptr;
    if (gInstance->mTokenCacheRecords.Get(aKey, &cacheEntry)) {
      for (const auto& rec : cacheEntry->Records()) {
        removedIds.AppendElement(rec->mId);
      }
    }
    rv = gInstance->RemoveAllLocked(aKey);
  }
  for (uint64_t id : removedIds) {
    ssl_tokens_cache_remove(id);
  }
  return rv;
}

nsresult SSLTokensCache::RemoveAllLocked(const nsACString& aKey) {
  sLock.AssertCurrentThreadOwns();

  LOG(("SSLTokensCache::RemoveAllLocked [key=%s]",
       PromiseFlatCString(aKey).get()));

  UniquePtr<TokenCacheEntry> cacheEntry;
  if (!mTokenCacheRecords.Remove(aKey, &cacheEntry)) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  mCacheSize -= cacheEntry->Size();
  cacheEntry = nullptr;

  LogStats();

  return NS_OK;
}

void SSLTokensCache::OnRecordDestroyed(TokenCacheRecord* aRec) {
  // Always called from destructors of map entries while sLock is held.
  sLock.AssertCurrentThreadOwns();
  mExpirationArray.RemoveElement(aRec);
}

void SSLTokensCache::EvictIfNecessary(nsTArray<uint64_t>& aEvictedIds) {
  sLock.AssertCurrentThreadOwns();
  // kilobytes to bytes
  uint32_t capacity = StaticPrefs::network_ssl_tokens_cache_capacity() << 10;
  if (mCacheSize <= capacity) {
    return;
  }

  LOG(("SSLTokensCache::EvictIfNecessary: evicting"));

  mExpirationArray.Sort(ExpirationComparator());

  while (mCacheSize > capacity && mExpirationArray.Length() > 0) {
    mozilla::glean::network::ssl_token_cache_evictions.Add(1);
    uint64_t evictedId = mExpirationArray[0]->mId;
    DebugOnly<nsresult> rv = RemoveLocked(mExpirationArray[0]->mKey, evictedId);
    MOZ_ASSERT(NS_SUCCEEDED(rv),
               "mExpirationArray and mTokenCacheRecords are out of sync!");
    aEvictedIds.AppendElement(evictedId);
  }
}

void SSLTokensCache::LogStats() {
  sLock.AssertCurrentThreadOwns();
  if (!LOG5_ENABLED()) {
    return;
  }
  LOG(("SSLTokensCache::LogStats [count=%zu, cacheSize=%u]",
       mExpirationArray.Length(), mCacheSize));
  for (const auto& ent : mTokenCacheRecords.Values()) {
    const UniquePtr<TokenCacheRecord>& rec = ent->Get();
    LOG(("  [key=%s, count=%d]", rec->mKey.get(), ent->RecordCount()));
  }
}

size_t SSLTokensCache::SizeOfIncludingThis(
    mozilla::MallocSizeOf mallocSizeOf) const {
  size_t n = mallocSizeOf(this);

  n += mTokenCacheRecords.ShallowSizeOfExcludingThis(mallocSizeOf);
  n += mExpirationArray.ShallowSizeOfExcludingThis(mallocSizeOf);

  for (const auto* rec : mExpirationArray) {
    n += mallocSizeOf(rec);
    n += rec->mKey.SizeOfExcludingThisIfUnshared(mallocSizeOf);
    n += rec->mToken.ShallowSizeOfExcludingThis(mallocSizeOf);
  }

  return n;
}

MOZ_DEFINE_MALLOC_SIZE_OF(SSLTokensCacheMallocSizeOf)

NS_IMETHODIMP
SSLTokensCache::CollectReports(nsIHandleReportCallback* aHandleReport,
                               nsISupports* aData, bool aAnonymize) {
  StaticMutexAutoLock lock(sLock);

  MOZ_COLLECT_REPORT("explicit/network/ssl-tokens-cache", KIND_HEAP,
                     UNITS_BYTES,
                     SizeOfIncludingThis(SSLTokensCacheMallocSizeOf),
                     "Memory used for the SSL tokens cache.");

  return NS_OK;
}

static void RemoveFilesSync(nsIFile* aBackingFile) {
  aBackingFile->Remove(false);
  nsCOMPtr<nsIFile> tmp;
  aBackingFile->Clone(getter_AddRefs(tmp));
  tmp->SetLeafName(u"ssl_tokens_cache.tmp"_ns);
  tmp->Remove(false);
}

static void DispatchFileRemoval(nsCOMPtr<nsIFile> aBackingFile) {
  NS_DispatchBackgroundTask(NS_NewRunnableFunction(
      "SSLTokensCache::RemoveFiles", [backingFile = std::move(aBackingFile)]() {
        RemoveFilesSync(backingFile);
      }));
}

// static
void SSLTokensCache::Clear() {
  LOG(("SSLTokensCache::Clear"));

  nsCOMPtr<nsIFile> backingFile;
  nsCOMPtr<nsISerialEventTarget> taskQueue;
  {
    StaticMutexAutoLock lock(sLock);
    if (!gInstance) {
      LOG(("  service not initialized"));
      return;
    }

    gInstance->ClearCacheLocked();
    backingFile = gInstance->mBackingFile;
    taskQueue = gInstance->mWriteTaskQueue;
  }

  ssl_tokens_cache_clear();

  if (backingFile) {
    if (taskQueue) {
      // Route through the serial write queue so the deletion is ordered after
      // any pending write task and cannot re-create the file after deletion.
      InvokeAsync(taskQueue.get(), __func__,
                  [bf = std::move(backingFile)]() mutable {
                    RemoveFilesSync(bf);
                    return GenericPromise::CreateAndResolve(true, __func__);
                  });
    } else {
      DispatchFileRemoval(std::move(backingFile));
    }
  }
}

void SSLTokensCache::DoWrite(bool aSynchronous) {
  nsTArray<uint64_t> validIds;
  nsCOMPtr<nsIFile> backingFile;
  nsCOMPtr<nsISerialEventTarget> taskQueue;
  {
    StaticMutexAutoLock lock(sLock);
    validIds = CollectValidIdsLocked();
    backingFile = mBackingFile;
    taskQueue = mWriteTaskQueue;
  }

  if (!backingFile) {
    if (XRE_IsSocketProcess() && !validIds.IsEmpty()) {
      // The socket process has no mWriteTaskQueue and only calls DoWrite
      // from Observe() (aSynchronous=false, main thread). Serialize on a
      // background thread to avoid blocking it.
      NS_DispatchBackgroundTask(
          NS_NewRunnableFunction("SSLTokensCache::DoWriteToParent", []() {
            nsTArray<uint8_t> data = SSLTokensCache::SerializeForIPC();
            if (data.IsEmpty()) {
              // Reachable on OOM or if gInstance was torn down after the
              // outer validIds.IsEmpty() check (e.g. concurrent Shutdown).
              return;
            }
            NS_DispatchToMainThread(NS_NewRunnableFunction(
                "SSLTokensCache::SendToParent", [data = std::move(data)]() {
                  auto* child = SocketProcessChild::GetSingleton();
                  if (child && child->CanSend()) {
                    (void)child->SendSSLTokensCacheData(
                        mozilla::ipc::ByteBufFrom(data));
                  }
                }));
          }));
    }
    return;
  }
  if (validIds.IsEmpty()) {
    if (aSynchronous) {
      // Already executing on mWriteTaskQueue (a background thread); remove
      // synchronously so the deletion doesn't get lost if the thread pool
      // is winding down during ProfileBeforeChange shutdown.
      RemoveFilesSync(backingFile);
    } else if (!taskQueue) {
      DispatchFileRemoval(std::move(backingFile));
    } else {
      // Async path: run the deletion on the serial queue directly so it is
      // ordered after any pending write tasks and cannot race against them.
      InvokeAsync(taskQueue.get(), __func__,
                  [bf = std::move(backingFile)]() mutable {
                    RemoveFilesSync(bf);
                    return GenericPromise::CreateAndResolve(true, __func__);
                  });
    }
    return;
  }
  nsAutoString widePath;
  if (NS_FAILED(backingFile->GetPath(widePath))) {
    return;
  }
  nsCString pathStr = NS_ConvertUTF16toUTF8(widePath);

  if (aSynchronous) {
    ssl_tokens_cache_write(&pathStr, &validIds);
  } else {
    if (!taskQueue) {
      return;
    }
    InvokeAsync(taskQueue.get(), __func__,
                [path = std::move(pathStr), ids = std::move(validIds)]() {
                  ssl_tokens_cache_write(&path, &ids);
                  return GenericPromise::CreateAndResolve(true, __func__);
                });
  }
}

// static
void SSLTokensCache::OnLoadCompleteNotify(uint32_t aCount) {
  mozilla::glean::network::ssl_token_cache_persistence_records_loaded.Add(
      AssertedCast<int32_t>(aCount));

  TimeDuration elapsed;
  {
    StaticMutexAutoLock lock(sLock);
    if (!gInstance) {
      return;
    }
    gInstance->mLoadComplete = true;
    elapsed = TimeStamp::Now() - gInstance->mLoadStartTime;
  }
  mozilla::glean::network::ssl_token_cache_load_time.AccumulateRawDuration(
      elapsed);
  LOG(("SSLTokensCache::OnLoadCompleteNotify [records=%u, time=%.1fms]", aCount,
       elapsed.ToMilliseconds()));

  // Forward persisted tokens to the socket process. Uses
  // CallOrWaitForSocketProcess so it fires immediately if the socket process
  // is already up, or is deferred until it is ready.
  if (StaticPrefs::network_ssl_tokens_cache_persistence()) {
    NS_DispatchToMainThread(
        NS_NewRunnableFunction("SSLTokensCache::ForwardToSocketProcess", []() {
          if (!gIOService || !nsIOService::UseSocketProcess()) {
            return;
          }
          // Serialize on a background thread, then send on the main thread.
          // No captures: CallOrWaitForSocketProcess copies its callable when
          // deferring, so the lambda must remain copyable.
          gIOService->CallOrWaitForSocketProcess([]() {
            NS_DispatchBackgroundTask(NS_NewRunnableFunction(
                "SSLTokensCache::SerializeForSocket", []() {
                  nsTArray<uint8_t> data = SSLTokensCache::SerializeForIPC();
                  if (data.IsEmpty()) {
                    return;
                  }
                  NS_DispatchToMainThread(NS_NewRunnableFunction(
                      "SSLTokensCache::SendToSocket",
                      [data = std::move(data)]() {
                        RefPtr<SocketProcessParent> parent =
                            SocketProcessParent::GetSingleton();
                        if (parent && parent->CanSend()) {
                          (void)parent->SendLoadSSLTokensCache(
                              mozilla::ipc::ByteBufFrom(data));
                        }
                      }));
                }));
          });
        }));
  }
}

// static
bool SSLTokensCache::PutFromPersisted(const SslTokensPersistedRecord* aRec,
                                      uint32_t aExpectedGen) {
  AutoTArray<uint64_t, 2> evictedIds;
  bool shouldAppend = false;
  SslTokensPersistedRecord shadowRec{};

  {
    StaticMutexAutoLock lock(sLock);
    if (!gInstance || gInstance->mLoadGeneration != aExpectedGen) {
      return false;
    }

    auto rec = MakeUnique<TokenCacheRecord>();
    rec->mKey = aRec->key;
    rec->mExpirationTime = static_cast<PRTime>(aRec->expiration_time);
    rec->mToken.AppendElements(aRec->token, aRec->token_len);
    rec->mSessionCacheInfo.mEVStatus =
        aRec->ev_status ? psm::EVStatus::EV : psm::EVStatus::NotEV;
    rec->mSessionCacheInfo.mCertificateTransparencyStatus = aRec->ct_status;
    rec->mSessionCacheInfo.mOverridableErrorCategory =
        static_cast<nsITransportSecurityInfo::OverridableErrorCategory>(
            aRec->overridable_error);
    uint64_t newId = gInstance->InsertRecordLocked(std::move(rec), evictedIds);

    // Keep the Rust shadow in sync so DoWrite includes this record on the next
    // flush. Use the newly-assigned sRecordId so validIds filtering works.
    // Apply the same guards as Put(): never shadow PBM tokens or tokens for
    // connections with cert-error overrides.
    if ((gInstance->mBackingFile || XRE_IsSocketProcess()) &&
        ShouldPersistKey(aRec->key, aRec->overridable_error)) {
      shadowRec = *aRec;
      shadowRec.id = newId;
      shouldAppend = true;
    }
  }  // sLock released

  for (uint64_t id : evictedIds) {
    ssl_tokens_cache_remove(id);
  }
  if (shouldAppend) {
    ssl_tokens_cache_append(&shadowRec);
  }
  return true;
}

uint64_t SSLTokensCache::InsertRecordLocked(UniquePtr<TokenCacheRecord> aRec,
                                            nsTArray<uint64_t>& aEvictedIds) {
  sLock.AssertCurrentThreadOwns();
  // Assign the ID here rather than in per-caller lambdas; this function already
  // holds sLock, so sRecordId is accessible without a closure.
  const uint64_t id = ++sRecordId;
  aRec->mId = id;

  // aRec->mKey must be read before AddRecord() moves aRec.
  TokenCacheEntry* cacheEntry = mTokenCacheRecords.GetOrInsertNew(aRec->mKey);
  if (cacheEntry->RecordCount() > 0) {
    mCacheSize -= cacheEntry->Size();
    // If at per-entry capacity, AddRecord will silently drop the oldest record.
    // Capture its ID now so the caller can sync the Rust shadow.
    if (cacheEntry->RecordCount() ==
        StaticPrefs::network_ssl_tokens_cache_records_per_entry()) {
      aEvictedIds.AppendElement(cacheEntry->Records()[0]->mId);
    }
  }
  cacheEntry->AddRecord(std::move(aRec), mExpirationArray);
  mCacheSize += cacheEntry->Size();
  EvictIfNecessary(aEvictedIds);
  return id;
}

// static
bool SSLTokensCache::ShouldPersistKey(const nsACString& aKey,
                                      uint8_t aOverridableError) {
  return aOverridableError == 0 && OAFromPeerId(aKey).mPrivateBrowsingId == 0;
}

template <typename Pred>
void SSLTokensCache::RemoveMatchingAndSync(Pred&& aPredicate) {
  nsTArray<uint64_t> remainingIds;
  {
    StaticMutexAutoLock lock(sLock);
    if (!gInstance) {
      return;
    }
    remainingIds =
        gInstance->RemoveMatchingLocked(std::forward<Pred>(aPredicate));
  }
  SyncRustShadow(std::move(remainingIds));
}

// static
void SSLTokensCache::RemoveByMatchAndOAPattern(
    const nsACString& aValue, const nsACString& aSeparatedValue,
    const mozilla::OriginAttributesPattern& aPattern) {
  // The basePart of a key is "host:port"; HostFromBasePart's RFindChar is
  // safe for bare IPv6 addresses.
  RemoveMatchingAndSync(
      [&aValue, &aSeparatedValue, &aPattern](const nsACString& aKey) {
        nsDependentCSubstring host = HostFromBasePart(BasePartFromKey(aKey));
        return !host.IsEmpty() &&
               (host.Equals(aValue) || StringEndsWith(host, aSeparatedValue)) &&
               aPattern.Matches(OAFromPeerId(aKey));
      });
}

// static
void SSLTokensCache::RemoveByHostAndOAPattern(
    const nsACString& aHost, const mozilla::OriginAttributesPattern& aPattern) {
  LOG(("SSLTokensCache::RemoveByHostAndOAPattern"));
  RemoveByMatchAndOAPattern(aHost, ":"_ns + aHost, aPattern);
}

// static
void SSLTokensCache::RemoveBySiteAndOAPattern(
    const nsACString& aSite, const mozilla::OriginAttributesPattern& aPattern) {
  LOG(("SSLTokensCache::RemoveBySiteAndOAPattern"));

  // Three cases for the host part of a key (after HostFromBasePart):
  //   "example.com"       — exact, no prefix        → Equals(aSite)
  //   "sub.example.com"   — subdomain                → ends with "."_ns + aSite
  //   "anon:example.com"  — connection-type prefix   → ends with ":"_ns + aSite
  // (Prefixed subdomains like "anon:sub.example.com" are caught by dotSite.)
  nsAutoCString dotSite("."_ns + aSite);
  nsAutoCString colonSite(":"_ns + aSite);
  RemoveMatchingAndSync(
      [&aSite, &dotSite, &colonSite, &aPattern](const nsACString& aKey) {
        nsDependentCSubstring host = HostFromBasePart(BasePartFromKey(aKey));
        return !host.IsEmpty() &&
               (host.Equals(aSite) || StringEndsWith(host, dotSite) ||
                StringEndsWith(host, colonSite)) &&
               aPattern.Matches(OAFromPeerId(aKey));
      });
}

#ifdef ENABLE_TESTS

// static
void SSLTokensCache::TriggerWriteForTest(const nsACString& aPath) {
  nsTArray<uint64_t> ids;
  {
    StaticMutexAutoLock lock(sLock);
    if (!gInstance) {
      return;
    }
    ids = gInstance->CollectValidIdsLocked();
  }
  nsCString flatPath(aPath);
  ssl_tokens_cache_write(&flatPath, &ids);
}

// static
void SSLTokensCache::LoadForTest(const nsACString& aPath) {
  uint32_t loadGen = 0;
  {
    StaticMutexAutoLock lock(sLock);
    if (gInstance) {
      loadGen = gInstance->mLoadGeneration;
    }
  }
  nsCString flatPath(aPath);
  ssl_tokens_cache_read(&flatPath, PR_Now(), PutFromPersistedCallback,
                        &loadGen);
}

// static
uint32_t SSLTokensCache::CountForTest() {
  StaticMutexAutoLock lock(sLock);
  if (!gInstance) {
    return 0;
  }
  return gInstance->mTokenCacheRecords.Count();
}

// static
void SSLTokensCache::PutForTest(const nsACString& aKey) {
  uint32_t gen = 0;
  {
    StaticMutexAutoLock lock(sLock);
    if (gInstance) {
      gen = gInstance->mLoadGeneration;
    }
  }
  uint8_t dummyToken[] = {0xDE, 0xAD, 0xBE, 0xEF};
  SslTokensPersistedRecord rec{};
  rec.key = aKey;
  rec.expiration_time = PR_Now() + 3600LL * PR_USEC_PER_SEC;
  rec.token = dummyToken;
  rec.token_len = sizeof(dummyToken);
  PutFromPersisted(&rec, gen);
}

#endif  // ENABLE_TESTS

NS_IMETHODIMP
SSLTokensCache::Observe(nsISupports* aSubject, const char* aTopic,
                        const char16_t* aData) {
  if (!strcmp(aTopic, "application-background") ||
      !strcmp(aTopic, "idle-daily")) {
    DoWrite(false);
  }
  return NS_OK;
}

// nsIAsyncShutdownBlocker

NS_IMETHODIMP
SSLTokensCache::BlockShutdown(nsIAsyncShutdownClient* /* aClient */) {
  MOZ_ASSERT(NS_IsMainThread());
  MOZ_ASSERT(XRE_IsParentProcess());
  nsCOMPtr<nsISerialEventTarget> taskQueue;
  {
    StaticMutexAutoLock lock(sLock);
    taskQueue = mWriteTaskQueue;
  }
  if (!taskQueue) {
    RemoveShutdownBlocker();
    return NS_OK;
  }

  // Helper that dispatches the actual disk write to the background queue
  // and then removes the shutdown blocker on the main thread once done.
  RefPtr<SSLTokensCache> self = this;
  auto doWriteAndRelease = [taskQueue, self]() {
    InvokeAsync(taskQueue.get(), "SSLTokensCache::BlockShutdown::DoWrite",
                [self]() {
                  self->DoWrite(true);
                  NS_DispatchToMainThread(NS_NewRunnableFunction(
                      "SSLTokensCache::RemoveShutdownBlocker",
                      [self]() { self->RemoveShutdownBlocker(); }));
                  return GenericPromise::CreateAndResolve(true, __func__);
                });
  };

  // If the socket process is alive, request a final token flush before writing
  // so the persisted file reflects the most recent handshake data.
  RefPtr<SocketProcessParent> socketParent =
      SocketProcessParent::GetSingleton();
  if (socketParent && socketParent->CanSend()) {
    socketParent->SendFlushSSLTokensCache()->Then(
        GetMainThreadSerialEventTarget(), __func__,
        [doWriteAndRelease](mozilla::ipc::ByteBuf&& aBuf) {
          // Empty response (null gInstance on socket side, or OOM) — skip
          // deserialization and write whatever the parent already has.
          if (aBuf.mLen == 0) {
            doWriteAndRelease();
            return;
          }
          // Deserialize off the main thread to avoid racing concurrent
          // background serialization tasks (both paths go through the Rust
          // STATE mutex, but clear+deserialize must be atomic w.r.t. any
          // concurrent serialize). Chain the disk write after completion.
          // If the background pool is winding down, fall back to
          // doWriteAndRelease without the flush to avoid a shutdown hang.
          nsresult rv = NS_DispatchBackgroundTask(NS_NewRunnableFunction(
              "SSLTokensCache::DeserializeFromFlush",
              [doWriteAndRelease, buf = std::move(aBuf)]() {
                SSLTokensCache::DeserializeFromIPC(Span(buf.mData, buf.mLen));
                NS_DispatchToMainThread(NS_NewRunnableFunction(
                    "SSLTokensCache::DoWriteAfterFlush",
                    [doWriteAndRelease]() { doWriteAndRelease(); }));
              }));
          if (NS_FAILED(rv)) {
            doWriteAndRelease();
          }
        },
        [doWriteAndRelease](mozilla::ipc::ResponseRejectReason) {
          // Socket process gone — write whatever the parent has.
          doWriteAndRelease();
        });
    return NS_OK;
  }

  doWriteAndRelease();
  return NS_OK;
}

NS_IMETHODIMP
SSLTokensCache::GetName(nsAString& aName) {
  aName.AssignLiteral("SSLTokensCache: writing cache to disk");
  return NS_OK;
}

NS_IMETHODIMP
SSLTokensCache::GetState(nsIPropertyBag** aState) {
  *aState = nullptr;
  return NS_OK;
}

void SSLTokensCache::RemoveShutdownBlocker() {
  nsCOMPtr<nsIAsyncShutdownClient> barrier;
  {
    StaticMutexAutoLock lock(sLock);
    barrier = std::move(mShutdownBarrier);
  }
  if (barrier) {
    barrier->RemoveBlocker(this);
  }
}

}  // namespace net
}  // namespace mozilla
