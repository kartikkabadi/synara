//! Persisted direct-model choices. Configuration is inert, revision checked and
//! separate from agent profiles, agent sessions and ACP configuration.
use crate::{StorageError, WorkspaceError, WorkspaceResult, WorkspaceService, now_ms};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use synara_core::{Role, TaskId, Thread};
pub use synara_model::{ModelSelection, ProviderProfile, ProviderSettings};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DirectModelBinding {
    pub selection: ModelSelection,
    pub reviewed_profile_sha256: String,
}
impl DirectModelBinding {
    pub fn reviewed(
        settings: &ProviderSettings,
        selection: ModelSelection,
    ) -> WorkspaceResult<Self> {
        settings
            .validate()
            .map_err(|error| WorkspaceError::Invalid(error.to_string()))?;
        let profile = settings
            .providers
            .iter()
            .find(|profile| profile.id == selection.provider_id)
            .ok_or_else(|| {
                WorkspaceError::Invalid("The selected direct provider is unavailable.".into())
            })?;
        synara_model::validate_request(
            profile,
            &selection.request(vec![synara_model::Message::text(
                synara_model::MessageRole::User,
                "Validate reviewed model selection".into(),
            )]),
        )
        .map_err(|error| WorkspaceError::Invalid(error.to_string()))?;
        Ok(Self {
            reviewed_profile_sha256: profile_digest(profile)?,
            selection,
        })
    }

    pub fn profile<'a>(
        &self,
        settings: &'a ProviderSettings,
    ) -> WorkspaceResult<&'a ProviderProfile> {
        let profile = settings
            .providers
            .iter()
            .find(|p| p.id == self.selection.provider_id)
            .ok_or_else(|| {
                WorkspaceError::Invalid(
                    "The direct provider was removed. Review another model in Settings.".into(),
                )
            })?;
        if profile_digest(profile)? != self.reviewed_profile_sha256 {
            return Err(WorkspaceError::Invalid("The direct provider configuration changed. Review and select it again before sending.".into()));
        }
        Ok(profile)
    }
}
pub(crate) fn profile_digest(profile: &ProviderProfile) -> WorkspaceResult<String> {
    let bytes = serde_json::to_vec(profile).map_err(StorageError::Encoding)?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

/// Suggest the explicit retained-history policy that fits inside the reviewed
/// model context window without mutating or summarizing the durable transcript.
///
/// The estimator deliberately treats each UTF-8/base64 byte as at most one token,
/// then adds bounded message overhead and reserves space for the next prompt.
/// That is conservative for the supported text/image transports: the returned
/// window may be smaller than necessary, but it will never expand history.
pub fn suggested_direct_history_turns(
    thread: &Thread,
    context_window: u64,
    max_output_tokens: u32,
) -> Option<u16> {
    let remaining_after_output = context_window.saturating_sub(u64::from(max_output_tokens));
    let prompt_reserve = (context_window / 8)
        .clamp(256, 8192)
        .min(remaining_after_output);
    let budget = remaining_after_output.saturating_sub(prompt_reserve);

    let mut turns: Vec<u64> = Vec::new();
    for message in thread
        .messages
        .iter()
        .filter(|message| matches!(message.role, Role::User | Role::Assistant))
    {
        let mut cost = 128u64.saturating_add(message.text.len() as u64);
        for image in thread
            .images
            .iter()
            .filter(|image| image.message_id == message.id && image.role == message.role)
        {
            cost = cost
                .saturating_add(128)
                .saturating_add(image.image.mime_type.len() as u64)
                .saturating_add(image.image.base64.len() as u64);
        }
        if message.role == Role::User {
            turns.push(cost);
        } else if let Some(turn) = turns.last_mut() {
            *turn = turn.saturating_add(cost);
        }
    }

    if turns.iter().copied().sum::<u64>() <= budget {
        return None;
    }

    let mut retained = 0u16;
    let mut used = 0u64;
    for cost in turns.iter().rev().take(256) {
        if used.saturating_add(*cost) > budget {
            break;
        }
        used = used.saturating_add(*cost);
        retained = retained.saturating_add(1);
    }
    Some(retained)
}
impl WorkspaceService {
    pub async fn direct_model_settings(&self) -> WorkspaceResult<ProviderSettings> {
        self.access(|store| {
            let settings: ProviderSettings = store
                .preference("direct-model-providers-v1")?
                .unwrap_or_default();
            settings
                .validate()
                .map_err(|e| WorkspaceError::Invalid(e.to_string()))?;
            Ok(settings)
        })
        .await
    }
    pub async fn direct_model_binding(
        &self,
        task: TaskId,
    ) -> WorkspaceResult<Option<DirectModelBinding>> {
        self.access(move |store| {
            store.task(task)?.ok_or(WorkspaceError::NotFound)?;
            Ok(store
                .preference::<Option<DirectModelBinding>>(&format!("task-direct-model:{task}"))?
                .flatten())
        })
        .await
    }
    pub(crate) async fn save_direct_model_settings(
        &self,
        settings: ProviderSettings,
    ) -> WorkspaceResult<ProviderSettings> {
        settings
            .validate()
            .map_err(|e| WorkspaceError::Invalid(e.to_string()))?;
        self.access(move |store| store.save_direct_model_settings(settings))
            .await
    }
    pub(crate) async fn bind_direct_model(
        &self,
        task: TaskId,
        selection: Option<ModelSelection>,
        settings_revision: u64,
        reviewed_sequence: u64,
    ) -> WorkspaceResult<Option<DirectModelBinding>> {
        self.access(move |store| {
            store.bind_direct_model(task, selection, settings_revision, reviewed_sequence)
        })
        .await
    }
}

const PROVIDER_CATALOG_PREFERENCE: &str = "direct-model-catalog-v1";

/// Persisted models.dev payload snapshot. Hydration re-runs the same bounded
/// parse as a live fetch, so a snapshot is never authoritative over it — it
/// only lets a reopened picker render last-known provider entries instantly.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PersistedProviderCatalog {
    pub source: serde_json::Value,
    /// Unix milliseconds when the payload was fetched.
    pub stored_at_ms: i64,
}
impl WorkspaceService {
    pub async fn provider_catalog_snapshot(
        &self,
    ) -> WorkspaceResult<Option<PersistedProviderCatalog>> {
        self.access(|store| Ok(store.preference(PROVIDER_CATALOG_PREFERENCE)?))
            .await
    }
    /// Persist the reviewed fetch payload; returns the fetch timestamp.
    pub async fn save_provider_catalog_snapshot(
        &self,
        source: serde_json::Value,
    ) -> WorkspaceResult<i64> {
        let snapshot = PersistedProviderCatalog {
            source,
            stored_at_ms: now_ms(),
        };
        self.access(move |store| {
            store.set_preference(PROVIDER_CATALOG_PREFERENCE, &snapshot)?;
            Ok(snapshot.stored_at_ms)
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog_source() -> serde_json::Value {
        serde_json::json!({
            "example-provider": {
                "name": "Example provider",
                "npm": "@ai-sdk/openai-compatible",
                "api": "https://api.example.com/v1",
                "env": ["EXAMPLE_API_KEY"],
                "models": {
                    "example-model": {
                        "name": "Example model",
                        "tool_call": true,
                        "modalities": {"input": ["text"]},
                        "limit": {"context": 128000, "output": 8192}
                    }
                }
            }
        })
    }

    #[tokio::test]
    async fn provider_catalog_snapshot_round_trips_with_fetch_timestamp() {
        let service = WorkspaceService::memory().unwrap();
        assert!(service.provider_catalog_snapshot().await.unwrap().is_none());

        let before = now_ms();
        let stored_at = service
            .save_provider_catalog_snapshot(catalog_source())
            .await
            .unwrap();
        assert!(stored_at >= before);

        let snapshot = service.provider_catalog_snapshot().await.unwrap().unwrap();
        assert_eq!(snapshot.stored_at_ms, stored_at);
        // Hydration runs the same parse as a live fetch.
        let catalog = synara_model::parse_catalog(snapshot.source).unwrap();
        assert_eq!(catalog.providers.len(), 1);
        assert_eq!(catalog.providers[0].id, "example-provider");
    }

    #[tokio::test]
    async fn newer_provider_catalog_snapshot_replaces_the_stored_one() {
        let service = WorkspaceService::memory().unwrap();
        let first = service
            .save_provider_catalog_snapshot(catalog_source())
            .await
            .unwrap();
        let second = service
            .save_provider_catalog_snapshot(serde_json::json!({}))
            .await
            .unwrap();
        let snapshot = service.provider_catalog_snapshot().await.unwrap().unwrap();
        assert_eq!(snapshot.stored_at_ms, second);
        assert!(second >= first);
        assert!(
            synara_model::parse_catalog(snapshot.source)
                .unwrap()
                .providers
                .is_empty()
        );
    }
}
