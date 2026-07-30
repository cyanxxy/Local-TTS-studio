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
pub const DEFAULT_CUSTOM_VOICE_SPEAKER: &str = "Aiden";
pub const DEFAULT_CUSTOM_VOICE_LANGUAGE: &str = "English";
pub const MAX_GENERATION_TOKENS: i64 = 4_096;
// At 12 codec frames/second this allows 32 seconds for each <=200-character
// unit while preventing a single unit's KV cache from exhausting unified RAM.
pub const MAX_TEXT_UNIT_GENERATION_TOKENS: i64 = 384;

const MIN_TEXT_GENERATION_TOKENS: i64 = 128;
const GENERATION_TOKEN_OVERHEAD: usize = 96;

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
            max_new_tokens: max_new_tokens.clamp(64, MAX_GENERATION_TOKENS),
        }
    }

    pub fn effective_for_text(self, text: &str, language: &str, hard_limit: i64) -> Self {
        let char_count = text
            .chars()
            .filter(|character| !character.is_whitespace())
            .count();
        let uses_slow_character_budget = is_cjk_language(language) || text.chars().any(is_cjk);
        let estimated_tokens = if uses_slow_character_budget {
            char_count.saturating_mul(3)
        } else {
            char_count.saturating_mul(3).div_ceil(2)
        }
        .saturating_add(GENERATION_TOKEN_OVERHEAD);
        let estimated_tokens = i64::try_from(estimated_tokens).unwrap_or(i64::MAX);
        let effective_limit = hard_limit.clamp(64, MAX_GENERATION_TOKENS);

        Self {
            max_new_tokens: self
                .max_new_tokens
                .min(effective_limit)
                .min(estimated_tokens.max(MIN_TEXT_GENERATION_TOKENS)),
            ..self
        }
    }
}

impl Default for GenerationControls {
    fn default() -> Self {
        Self::new(0.9, 50, MAX_GENERATION_TOKENS)
    }
}

fn is_cjk_language(language: &str) -> bool {
    matches!(
        language.trim().to_ascii_lowercase().as_str(),
        "chinese" | "japanese" | "korean" | "zh" | "ja" | "ko"
    )
}

fn is_cjk(character: char) -> bool {
    matches!(
        character as u32,
        0x2E80..=0x2FFF
            | 0x3040..=0x30FF
            | 0x3100..=0x312F
            | 0x31A0..=0x31BF
            | 0x31F0..=0x31FF
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xAC00..=0xD7AF
            | 0xF900..=0xFAFF
            | 0x20000..=0x2FA1F
    )
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
        assert_eq!(controls.max_new_tokens, MAX_GENERATION_TOKENS);
    }

    #[test]
    fn generation_controls_default_to_the_model_generation_budget() {
        assert_eq!(
            GenerationControls::default().max_new_tokens,
            MAX_GENERATION_TOKENS
        );
    }

    #[test]
    fn generation_budget_scales_with_text_and_respects_requested_and_hard_limits() {
        let controls = GenerationControls::new(0.9, 50, 3_000);
        assert_eq!(
            controls
                .effective_for_text(
                    "A short sentence.",
                    "english",
                    MAX_TEXT_UNIT_GENERATION_TOKENS,
                )
                .max_new_tokens,
            128
        );
        assert_eq!(
            controls
                .effective_for_text(&"a".repeat(400), "english", MAX_TEXT_UNIT_GENERATION_TOKENS,)
                .max_new_tokens,
            MAX_TEXT_UNIT_GENERATION_TOKENS
        );
        assert_eq!(
            controls
                .effective_for_text(&"你".repeat(400), "auto", MAX_TEXT_UNIT_GENERATION_TOKENS,)
                .max_new_tokens,
            MAX_TEXT_UNIT_GENERATION_TOKENS
        );
        assert_eq!(
            controls
                .effective_for_text(&"a".repeat(6_000), "english", 9_999)
                .max_new_tokens,
            3_000
        );
        assert_eq!(
            GenerationControls::new(0.9, 50, 256)
                .effective_for_text(
                    &"你".repeat(400),
                    "chinese",
                    MAX_TEXT_UNIT_GENERATION_TOKENS,
                )
                .max_new_tokens,
            256
        );
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
        assert!(SPEAKERS.contains(&DEFAULT_CUSTOM_VOICE_SPEAKER));
        assert_eq!(
            normalize_language(DEFAULT_CUSTOM_VOICE_LANGUAGE).unwrap(),
            "english"
        );
        assert_eq!(normalize_speaker("Uncle_Fu").unwrap(), "uncle_fu");
        assert_eq!(normalize_speaker("Ono_Anna").unwrap(), "ono_anna");
        assert!(normalize_speaker("unknown").is_err());
    }
}
