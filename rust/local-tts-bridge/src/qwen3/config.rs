use anyhow::{Result, bail};

use super::text::is_cjk;

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
// Every request is generated one bounded text unit at a time, so the budget a
// caller can set is a per-unit budget. At 12 codec frames/second this allows
// 32 seconds for each unit while preventing a single unit's KV cache from
// exhausting unified RAM. Mirrored by `QWEN3_MAX_NEW_TOKENS` in
// `src/contexts/Qwen3RuntimeContext.tsx` and the IPC bounds in
// `electron/localTtsIpc.ts`.
pub const MAX_TEXT_UNIT_GENERATION_TOKENS: i64 = 384;
pub const MAX_GENERATION_TOKENS: i64 = MAX_TEXT_UNIT_GENERATION_TOKENS;
pub const MIN_GENERATION_TOKENS: i64 = 64;

const MIN_TEXT_GENERATION_TOKENS: i64 = 128;
const GENERATION_TOKEN_OVERHEAD: usize = 96;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GenerationControls {
    pub temperature: f64,
    pub top_k: i64,
    pub max_new_tokens: i64,
}

impl GenerationControls {
    /// Temperature 0 selects greedy decoding; top-k is always at least 1 so a
    /// request can never silently fall back to unrestricted sampling.
    pub fn new(temperature: f64, top_k: i64, max_new_tokens: i64) -> Self {
        Self {
            temperature: temperature.clamp(0.0, 2.0),
            top_k: top_k.clamp(1, 1_000),
            max_new_tokens: max_new_tokens.clamp(MIN_GENERATION_TOKENS, MAX_GENERATION_TOKENS),
        }
    }

    /// Bound the budget by what this unit can plausibly need, so a generation
    /// that never emits end-of-speech stops early instead of running to the
    /// hard limit. The estimate is deliberately generous: a slow instruct or a
    /// passage of numerals speaks far more frames per character than prose.
    pub fn effective_for_text(self, text: &str, language: &str, hard_limit: i64) -> Self {
        let char_count = text
            .chars()
            .filter(|character| !character.is_whitespace())
            .count();
        let uses_slow_character_budget = is_cjk_language(language) || text.chars().any(is_cjk);
        let estimated_tokens = if uses_slow_character_budget {
            char_count.saturating_mul(3)
        } else {
            char_count.saturating_mul(2)
        }
        .saturating_add(GENERATION_TOKEN_OVERHEAD);
        let estimated_tokens = i64::try_from(estimated_tokens).unwrap_or(i64::MAX);
        let effective_limit = hard_limit.clamp(MIN_GENERATION_TOKENS, MAX_GENERATION_TOKENS);

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

        let controls = GenerationControls::new(-1.0, 0, 1);
        assert_eq!(controls.temperature, 0.0);
        assert_eq!(controls.top_k, 1);
        assert_eq!(controls.max_new_tokens, MIN_GENERATION_TOKENS);
    }

    #[test]
    fn generation_controls_default_to_the_per_unit_budget() {
        assert_eq!(
            GenerationControls::default().max_new_tokens,
            MAX_GENERATION_TOKENS
        );
        assert_eq!(MAX_GENERATION_TOKENS, MAX_TEXT_UNIT_GENERATION_TOKENS);
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
        // 100 Latin characters estimate 2 * 100 + 96 = 296 frames.
        assert_eq!(
            controls
                .effective_for_text(&"a".repeat(100), "english", MAX_TEXT_UNIT_GENERATION_TOKENS)
                .max_new_tokens,
            296
        );
        assert_eq!(
            controls
                .effective_for_text(&"a".repeat(400), "english", MAX_TEXT_UNIT_GENERATION_TOKENS,)
                .max_new_tokens,
            MAX_TEXT_UNIT_GENERATION_TOKENS
        );
        // A full CJK unit (100 scalars at weight 2) still fits the hard limit
        // with margin at 3 frames per character.
        assert_eq!(
            controls
                .effective_for_text(&"你".repeat(90), "auto", MAX_TEXT_UNIT_GENERATION_TOKENS,)
                .max_new_tokens,
            366
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
            MAX_GENERATION_TOKENS
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
