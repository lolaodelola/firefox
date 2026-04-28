/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use crate::crypto::{self, CipherSuite, DEFAULT_CIPHER_SUITE};
use crate::utils;
use crate::{LockstoreError, SecurityLevel, KEK_REF_PREFIX};

use kvstore::{Database, GetOptions, Key, Store, StorePath};
use nss_gk_api::aead::Aead;
use nss_gk_api::p11;
use nss_gk_api::SymKey;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

const DB_NAME: &str = "lockstore.keys";
const DEK_PREFIX: &str = "lockstore::dek::";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WrappedDek {
    security_level: SecurityLevel,
    kek_ref: String,
    wrapped_dek: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DekMetadata {
    wrapped_deks: Vec<WrappedDek>,
    cipher_suite: CipherSuite,
    #[serde(default)]
    extractable: bool,
}

#[derive(Clone)]
pub struct LockstoreKeystore {
    store: Arc<Store>,
    in_memory: bool,
}

impl LockstoreKeystore {
    pub fn new(path: PathBuf) -> Result<Self, LockstoreError> {
        let store = Arc::new(Store::new(StorePath::OnDisk(path)));
        nss_gk_api::init();
        Ok(Self {
            store,
            in_memory: false,
        })
    }

    pub fn new_in_memory() -> Result<Self, LockstoreError> {
        let store = Arc::new(Store::new(StorePath::for_in_memory()));
        nss_gk_api::init();
        Ok(Self {
            store,
            in_memory: true,
        })
    }

    pub fn create_dek(
        &self,
        collection_name: &str,
        kek_ref: &str,
        extractable: bool,
    ) -> Result<(), LockstoreError> {
        self.create_dek_with_cipher(collection_name, kek_ref, extractable, DEFAULT_CIPHER_SUITE)
    }

    pub fn create_dek_with_cipher(
        &self,
        collection_name: &str,
        kek_ref: &str,
        extractable: bool,
        cipher_suite: CipherSuite,
    ) -> Result<(), LockstoreError> {
        let security_level = SecurityLevel::from_kek_ref(kek_ref)?;

        let dek_key = format!("{}{}", DEK_PREFIX, collection_name);
        let db = Database::new(&self.store, DB_NAME);
        let key = Key::from(dek_key.as_str());
        let existing = db.get(&key, &GetOptions::default())?;

        if existing.is_some() {
            return Err(LockstoreError::InvalidConfiguration(format!(
                "DEK already exists for collection: {}",
                collection_name
            )));
        }

        let new_dek = crypto::generate_random_key(cipher_suite);
        let kek = self.get_kek_symkey(cipher_suite, kek_ref)?;
        let wrapped = crypto::encrypt_with_symkey(&new_dek, &kek, cipher_suite)?;

        let metadata = DekMetadata {
            wrapped_deks: vec![WrappedDek {
                security_level,
                kek_ref: kek_ref.to_string(),
                wrapped_dek: wrapped,
            }],
            cipher_suite,
            extractable,
        };

        self.save_metadata(collection_name, &metadata)
    }

    pub(crate) fn get_dek_internal(
        &self,
        collection_name: &str,
        kek_ref: &str,
    ) -> Result<(Vec<u8>, CipherSuite, bool), LockstoreError> {
        let metadata = self.load_metadata(collection_name)?;

        let entry = metadata
            .wrapped_deks
            .iter()
            .find(|w| w.kek_ref == kek_ref)
            .ok_or_else(|| {
                LockstoreError::NotFound(format!(
                    "No DEK for collection '{}' with kek_ref '{}'",
                    collection_name, kek_ref
                ))
            })?;

        let kek = self.get_kek_symkey(metadata.cipher_suite, kek_ref)?;
        let dek = crypto::decrypt_with_symkey(&entry.wrapped_dek, &kek)?;

        Ok((dek, metadata.cipher_suite, metadata.extractable))
    }

    pub fn is_dek_extractable(&self, collection_name: &str) -> Result<bool, LockstoreError> {
        let metadata = self.load_metadata(collection_name)?;
        Ok(metadata.extractable)
    }

    pub fn get_dek(
        &self,
        collection_name: &str,
        kek_ref: &str,
    ) -> Result<(Vec<u8>, CipherSuite), LockstoreError> {
        if !self.is_dek_extractable(collection_name)? {
            return Err(LockstoreError::NotExtractable(format!(
                "DEK for '{}' is not extractable",
                collection_name
            )));
        }

        let (dek, cipher_suite, _) = self.get_dek_internal(collection_name, kek_ref)?;
        Ok((dek, cipher_suite))
    }

    pub fn add_security_level(
        &self,
        collection_name: &str,
        source_kek_ref: &str,
        new_kek_ref: &str,
    ) -> Result<(), LockstoreError> {
        let new_security_level = SecurityLevel::from_kek_ref(new_kek_ref)?;
        let mut metadata = self.load_metadata(collection_name)?;

        if metadata
            .wrapped_deks
            .iter()
            .any(|w| w.kek_ref == new_kek_ref)
        {
            return Err(LockstoreError::InvalidConfiguration(format!(
                "kek_ref '{}' already exists for collection '{}'",
                new_kek_ref, collection_name
            )));
        }

        let source_entry = metadata
            .wrapped_deks
            .iter()
            .find(|w| w.kek_ref == source_kek_ref)
            .ok_or_else(|| {
                LockstoreError::NotFound(format!(
                    "No DEK for collection '{}' with kek_ref '{}'",
                    collection_name, source_kek_ref
                ))
            })?;

        let source_kek = self.get_kek_symkey(metadata.cipher_suite, source_kek_ref)?;
        let dek = crypto::decrypt_with_symkey(&source_entry.wrapped_dek, &source_kek)?;

        let new_kek = self.get_kek_symkey(metadata.cipher_suite, new_kek_ref)?;
        let new_wrapped = crypto::encrypt_with_symkey(&dek, &new_kek, metadata.cipher_suite)?;

        metadata.wrapped_deks.push(WrappedDek {
            security_level: new_security_level,
            kek_ref: new_kek_ref.to_string(),
            wrapped_dek: new_wrapped,
        });

        self.save_metadata(collection_name, &metadata)
    }

    pub fn remove_security_level(
        &self,
        collection_name: &str,
        kek_ref: &str,
    ) -> Result<(), LockstoreError> {
        let mut metadata = self.load_metadata(collection_name)?;

        if metadata.wrapped_deks.len() <= 1 {
            return Err(LockstoreError::InvalidConfiguration(format!(
                "Cannot remove the last security level from collection '{}'",
                collection_name
            )));
        }

        let entry = metadata
            .wrapped_deks
            .iter()
            .find(|w| w.kek_ref == kek_ref)
            .ok_or_else(|| {
                LockstoreError::NotFound(format!(
                    "No DEK for collection '{}' with kek_ref '{}'",
                    collection_name, kek_ref
                ))
            })?;

        let kek = self.get_kek_symkey(metadata.cipher_suite, kek_ref)?;
        crypto::decrypt_with_symkey(&entry.wrapped_dek, &kek)?;

        metadata.wrapped_deks.retain(|w| w.kek_ref != kek_ref);

        self.save_metadata(collection_name, &metadata)
    }

    pub fn delete_dek(&self, collection_name: &str) -> Result<(), LockstoreError> {
        let dek_key = format!("{}{}", DEK_PREFIX, collection_name);
        let db = Database::new(&self.store, DB_NAME);
        let key = Key::from(dek_key.as_str());

        if !db.has(&key, &GetOptions::default())? {
            return Err(LockstoreError::NotFound(format!(
                "DEK not found for collection: {}",
                collection_name
            )));
        }

        crypto::secure_delete(&self.store, DB_NAME, &dek_key)
    }

    pub fn list_collections(&self) -> Result<Vec<String>, LockstoreError> {
        use kvstore::DatabaseError;

        let reader = self.store.reader()?;
        let db_name = DB_NAME.to_string();

        let collections = reader
            .read(|conn| {
                let mut stmt = conn
                    .prepare(
                        "SELECT data.key FROM data
                         JOIN dbs ON data.db_id = dbs.id
                         WHERE dbs.name = ?1
                         AND data.key LIKE ?2
                         ORDER BY data.key",
                    )
                    .map_err(DatabaseError::from)?;

                let dek_pattern = format!("{}%", DEK_PREFIX);
                let collection_strings: Result<Vec<String>, _> = stmt
                    .query_map([&db_name, &dek_pattern], |row| {
                        let key: String = row.get(0)?;
                        Ok(key.strip_prefix(DEK_PREFIX).unwrap_or(&key).to_string())
                    })
                    .map_err(DatabaseError::from)?
                    .collect();

                collection_strings.map_err(DatabaseError::from)
            })
            .map_err(LockstoreError::Database)?;

        Ok(collections)
    }

    pub fn close(self) {
        if self.in_memory {
            let _ = crypto::zeroize(&self.store, DB_NAME, "lockstore::kek::local");
        }
        self.store.close();
    }

    // ========================================================================
    // KEK retrieval
    // ========================================================================

    fn get_kek_symkey(
        &self,
        cipher_suite: CipherSuite,
        kek_ref: &str,
    ) -> Result<SymKey, LockstoreError> {
        let security_level = SecurityLevel::from_kek_ref(kek_ref)?;
        match security_level {
            SecurityLevel::LocalKey => {
                let kek_bytes = self.get_kek_local(cipher_suite, kek_ref)?;
                Aead::import_key(cipher_suite.to_nss_algorithm(), &kek_bytes)
                    .map_err(|e| LockstoreError::Encryption(e.to_string()))
            }
            SecurityLevel::Pkcs11Token => self.get_kek_from_token(cipher_suite, kek_ref),
            #[cfg(test)]
            SecurityLevel::TestLevel => {
                let kek_bytes = self.get_kek_local(cipher_suite, kek_ref)?;
                Aead::import_key(cipher_suite.to_nss_algorithm(), &kek_bytes)
                    .map_err(|e| LockstoreError::Encryption(e.to_string()))
            }
        }
    }

    fn get_kek_local(
        &self,
        cipher_suite: CipherSuite,
        kek_ref: &str,
    ) -> Result<Vec<u8>, LockstoreError> {
        let db = Database::new(&self.store, DB_NAME);
        let key = Key::from(kek_ref);

        let existing_kek = db.get(&key, &GetOptions::default())?;

        if let Some(value) = existing_kek {
            utils::value_to_bytes(&value)
        } else {
            let new_kek = crypto::generate_random_key(cipher_suite);
            let value = utils::bytes_to_value(&new_kek)?;
            db.put(&[(key, Some(value))])?;
            Ok(new_kek)
        }
    }

    fn get_kek_from_token(
        &self,
        cipher_suite: CipherSuite,
        kek_ref: &str,
    ) -> Result<SymKey, LockstoreError> {
        let pkcs11_uri_str = kek_ref.strip_prefix(KEK_REF_PREFIX).ok_or_else(|| {
            LockstoreError::InvalidKekRef(format!("Invalid kek_ref format: {}", kek_ref))
        })?;
        let uri = nss_gk_api::pkcs11_uri::parse(pkcs11_uri_str)
            .map_err(|_| LockstoreError::InvalidKekRef(format!("Invalid PKCS#11 URI: {}", kek_ref)))?;
        let slot = self.resolve_pkcs11_slot(&uri)?;

        slot.authenticate()
            .map_err(|_| LockstoreError::AuthenticationCancelled)?;

        if let Some(existing) = slot.find_key_by_nickname(kek_ref) {
            return Ok(existing);
        }

        slot.generate_token_key(
            p11::CKM_AES_KEY_GEN.into(),
            cipher_suite.key_size(),
            kek_ref,
        )
        .map_err(|e| LockstoreError::TokenError(format!("Failed to generate key: {}", e)))
    }

    fn resolve_pkcs11_slot(
        &self,
        uri: &nss_gk_api::pkcs11_uri::Pkcs11Uri,
    ) -> Result<p11::Slot, LockstoreError> {
        let token_name = uri.token.as_deref().ok_or_else(|| {
            LockstoreError::InvalidKekRef("PKCS#11 URI missing token attribute".into())
        })?;

        let internal_slot = p11::Slot::internal_key_slot()
            .map_err(|e| LockstoreError::TokenError(format!("Failed to get key slot: {}", e)))?;
        if internal_slot.token_name() == token_name {
            return Ok(internal_slot);
        }

        let slots = p11::all_token_slots(p11::CKM_AES_KEY_GEN.into())
            .map_err(|e| LockstoreError::TokenError(e.to_string()))?;
        for slot in slots {
            if slot.token_name() == token_name {
                return Ok(slot);
            }
        }

        Err(LockstoreError::TokenError(format!(
            "Token not found: {}",
            token_name
        )))
    }

    // ========================================================================
    // Metadata persistence
    // ========================================================================

    fn load_metadata(&self, collection_name: &str) -> Result<DekMetadata, LockstoreError> {
        let dek_key = format!("{}{}", DEK_PREFIX, collection_name);
        let db = Database::new(&self.store, DB_NAME);
        let key = Key::from(dek_key.as_str());

        let metadata_value = db.get(&key, &GetOptions::default())?.ok_or_else(|| {
            LockstoreError::NotFound(format!("DEK not found for collection: {}", collection_name))
        })?;

        let metadata_bytes = utils::value_to_bytes(&metadata_value)?;
        Ok(serde_json::from_slice(&metadata_bytes)?)
    }

    fn save_metadata(
        &self,
        collection_name: &str,
        metadata: &DekMetadata,
    ) -> Result<(), LockstoreError> {
        let dek_key = format!("{}{}", DEK_PREFIX, collection_name);
        let db = Database::new(&self.store, DB_NAME);
        let key = Key::from(dek_key.as_str());
        let metadata_bytes = serde_json::to_vec(metadata)?;
        let value = utils::bytes_to_value(&metadata_bytes)?;
        db.put(&[(key, Some(value))])?;
        Ok(())
    }
}
