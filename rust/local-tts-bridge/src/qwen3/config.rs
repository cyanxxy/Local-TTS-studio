use anyhow::{Result, bail};

pub const LANGUAGES: &[&str] = &[
    "auto",
    "chinese",
    "english",
    "japanese",
    "korean",
    "german",
    "french",
    "russian",
    "portuguese",
    "spanish",
    "italian",
];

pub const SPEAKERS: &[&str] = &[
    "Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee",
];

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GenerationControls {
    pub temperature: f64,
    pub top_k: i64,
    pub max_new_tokens: i64,
}

impl GenerationControls {
    pub fn new(temperature: f64, top_k: i64, max_new_tokens: i64) -> Self {
        Self {
            temperature: temperature.clamp(0.2, 2.0),
            top_k: top_k.clamp(0, 1_000),
            max_new_tokens: max_new_tokens.clamp(64, 8_192),
        }
    }
}

impl Default for GenerationControls {
    fn default() -> Self {
        Self::new(0.9, 50, 1_536)
    }
}

pub fn normalize_language(language: &str) -> Result<String> {
    let normalized = language.trim().to_lowercase();
    if LANGUAGES.contains(&normalized.as_str()) {
        Ok(normalized)
    } else {
        bail!("Unsupported Qwen3 language: {language}")
    }
}

pub fn normalize_speaker(speaker: &str) -> Result<String> {
    let display_name = speaker.trim();
    if SPEAKERS.contains(&display_name) {
        Ok(display_name.to_lowercase())
    } else {
        bail!("Unsupported Qwen3 speaker: {speaker}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generation_controls_are_bounded() {
        let controls = GenerationControls::new(99.0, 50_000, 99_999);
        assert_eq!(controls.temperature, 2.0);
        assert_eq!(controls.top_k, 1_000);
        assert_eq!(controls.max_new_tokens, 8_192);
    }

    #[test]
    fn all_languages_plus_auto_are_normalized() {
        for language in [
            "Auto",
            "Chinese",
            "English",
            "Japanese",
            "Korean",
            "German",
            "French",
            "Russian",
            "Portuguese",
            "Spanish",
            "Italian",
        ] {
            assert_eq!(
                normalize_language(language).unwrap(),
                language.to_lowercase()
            );
        }
        assert!(normalize_language("Klingon").is_err());
    }

    #[test]
    fn speakers_validate_as_display_names_and_resolve_lowercase_ids() {
        assert_eq!(normalize_speaker("Uncle_Fu").unwrap(), "uncle_fu");
        assert_eq!(normalize_speaker("Ono_Anna").unwrap(), "ono_anna");
        assert!(normalize_speaker("unknown").is_err());
    }
}
