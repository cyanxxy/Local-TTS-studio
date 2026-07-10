use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ExpectedModelType {
    CustomVoice,
    Base,
}

impl ExpectedModelType {
    fn config_value(self) -> &'static str {
        match self {
            Self::CustomVoice => "custom_voice",
            Self::Base => "base",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelDirectoryInfo {
    pub model_type: String,
    pub languages: BTreeSet<String>,
    pub speakers: BTreeSet<String>,
}

#[derive(Debug, Deserialize)]
struct ModelConfig {
    tts_model_type: String,
    talker_config: TalkerConfig,
}

#[derive(Debug, Deserialize)]
struct TalkerConfig {
    codec_language_id: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    spk_id: BTreeMap<String, serde_json::Value>,
}

fn ensure_nonempty_file(path: &Path, label: &str) -> Result<()> {
    let metadata =
        fs::metadata(path).with_context(|| format!("Missing {label}: {}", path.display()))?;
    ensure!(
        metadata.is_file() && metadata.len() > 0,
        "{label} is empty: {}",
        path.display()
    );
    Ok(())
}

pub fn validate_model_dir(path: &Path, expected: ExpectedModelType) -> Result<ModelDirectoryInfo> {
    ensure!(
        path.is_dir(),
        "Qwen3 model directory does not exist: {}",
        path.display()
    );

    let config_path = path.join("config.json");
    ensure_nonempty_file(&config_path, "Qwen3 config")?;
    let config: ModelConfig = serde_json::from_slice(
        &fs::read(&config_path)
            .with_context(|| format!("Failed to read {}", config_path.display()))?,
    )
    .with_context(|| format!("Failed to parse {}", config_path.display()))?;
    if config.tts_model_type != expected.config_value() {
        bail!(
            "Qwen3 model type mismatch: expected {}, found {}.",
            expected.config_value(),
            config.tts_model_type
        );
    }

    ensure_nonempty_file(&path.join("model.safetensors"), "Qwen3 model weights")?;
    let has_tokenizer_json = path.join("tokenizer.json").is_file();
    let has_bpe_files = path.join("vocab.json").is_file() && path.join("merges.txt").is_file();
    ensure!(
        has_tokenizer_json || has_bpe_files,
        "Qwen3 model requires tokenizer.json or both vocab.json and merges.txt."
    );
    ensure_nonempty_file(
        &path.join("speech_tokenizer/config.json"),
        "Qwen3 speech-tokenizer config",
    )?;
    ensure_nonempty_file(
        &path.join("speech_tokenizer/model.safetensors"),
        "Qwen3 speech-tokenizer weights",
    )?;

    Ok(ModelDirectoryInfo {
        model_type: config.tts_model_type,
        languages: config.talker_config.codec_language_id.into_keys().collect(),
        speakers: config.talker_config.spk_id.into_keys().collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn complete_model(model_type: &str) -> TempDir {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("speech_tokenizer")).unwrap();
        fs::write(
            dir.path().join("config.json"),
            format!(
                r#"{{"tts_model_type":"{model_type}","talker_config":{{"codec_language_id":{{"english":2050}},"spk_id":{{"ryan":3061}}}}}}"#,
            ),
        )
        .unwrap();
        fs::write(dir.path().join("model.safetensors"), [1]).unwrap();
        fs::write(dir.path().join("vocab.json"), b"{}").unwrap();
        fs::write(dir.path().join("merges.txt"), b"#version: 0.2").unwrap();
        fs::write(dir.path().join("speech_tokenizer/config.json"), b"{}").unwrap();
        fs::write(dir.path().join("speech_tokenizer/model.safetensors"), [1]).unwrap();
        dir
    }

    #[test]
    fn accepts_a_complete_matching_model_directory() {
        let dir = complete_model("custom_voice");
        let info = validate_model_dir(dir.path(), ExpectedModelType::CustomVoice).unwrap();
        assert!(info.languages.contains("english"));
        assert!(info.speakers.contains("ryan"));
    }

    #[test]
    fn rejects_missing_empty_wrong_type_and_incomplete_directories() {
        let missing = TempDir::new().unwrap();
        assert!(validate_model_dir(missing.path(), ExpectedModelType::CustomVoice).is_err());

        let wrong = complete_model("base");
        assert!(validate_model_dir(wrong.path(), ExpectedModelType::Base).is_ok());
        assert!(validate_model_dir(wrong.path(), ExpectedModelType::CustomVoice).is_err());

        let empty_weights = complete_model("custom_voice");
        fs::write(empty_weights.path().join("model.safetensors"), []).unwrap();
        assert!(validate_model_dir(empty_weights.path(), ExpectedModelType::CustomVoice).is_err());

        let missing_tokenizer = complete_model("custom_voice");
        fs::remove_file(
            missing_tokenizer
                .path()
                .join("speech_tokenizer/model.safetensors"),
        )
        .unwrap();
        assert!(
            validate_model_dir(missing_tokenizer.path(), ExpectedModelType::CustomVoice).is_err()
        );
    }
}
