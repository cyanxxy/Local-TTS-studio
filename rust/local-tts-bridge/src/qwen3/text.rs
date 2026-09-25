use anyhow::{Result, ensure};

use super::config::is_cjk;

const SENTENCE_BOUNDARIES: &[char] = &['.', '!', '?', '。', '！', '？', '；', ';', '\n'];
const CLAUSE_BOUNDARIES: &[char] = &[',', ':', '，', '：', '、'];

/// Budget units a CJK character spends. Qwen speaks one CJK character in
/// roughly the time of two Latin letters (the same 3-vs-1.5 tokens-per-character
/// ratio `GenerationControls::effective_for_text` estimates), so a CJK-heavy
/// unit is cut at about half the characters. That keeps its speech inside the
/// per-unit token cap without raising the cap, which is what bounds each
/// unit's KV cache.
const CJK_CHARACTER_WEIGHT: usize = 2;

/// Splits `text` into consecutive units by weighted length: one per character,
/// `CJK_CHARACTER_WEIGHT` per CJK character. The window closes on the character
/// that reaches `max_chars` (one over when a CJK character straddles it), and
/// each unit ends at the last sentence or clause boundary inside that window
/// when there is one.
///
/// `src/lib/qwenChunking.ts` mirrors this exactly so the renderer can map the
/// streamed `textUnitIndex` back onto source text; change both together.
pub fn split_text_units(text: &str, max_chars: usize) -> Result<Vec<String>> {
    ensure!(max_chars > 0, "Qwen3 text-unit budget must be positive.");
    ensure!(!text.trim().is_empty(), "Qwen3 text is empty.");

    let mut units = Vec::new();
    let mut start = 0usize;
    while start < text.len() {
        let mut weight = 0usize;
        let mut preferred_end = None;
        let mut hard_end = text.len();

        for (relative_offset, ch) in text[start..].char_indices() {
            weight += if is_cjk(ch) { CJK_CHARACTER_WEIGHT } else { 1 };
            let end = start + relative_offset + ch.len_utf8();
            if SENTENCE_BOUNDARIES.contains(&ch) || CLAUSE_BOUNDARIES.contains(&ch) {
                preferred_end = Some(end);
            }
            if weight >= max_chars {
                hard_end = end;
                break;
            }
        }

        let end = preferred_end.unwrap_or(hard_end);
        ensure!(end > start, "Qwen3 text splitter made no progress.");
        units.push(text[start..end].to_owned());
        start = end;
    }

    Ok(units)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cjk_without_spaces_never_slices_utf8_or_loses_text() {
        let text = "你好世界。".repeat(240);
        let units = split_text_units(&text, 120).unwrap();
        assert!(units.iter().all(|unit| unit.chars().count() <= 120));
        assert_eq!(units.concat(), text);
    }

    #[test]
    fn emoji_combining_marks_and_long_urls_round_trip() {
        let text = "Ame\u{301}lie🙂 https://example.test/".to_string() + &"路".repeat(300);
        let units = split_text_units(&text, 64).unwrap();
        assert!(units.iter().all(|unit| unit.chars().count() <= 64));
        assert_eq!(units.concat(), text);
    }

    #[test]
    fn cjk_units_use_half_the_character_budget() {
        let text = "你".repeat(250);
        let units = split_text_units(&text, 200).unwrap();
        assert_eq!(
            units
                .iter()
                .map(|unit| unit.chars().count())
                .collect::<Vec<_>>(),
            vec![100, 100, 50]
        );
        assert_eq!(units.concat(), text);

        // Mixed text spends one budget unit per Latin character and two per
        // CJK character, so this 150-character window weighs exactly 200.
        let mixed = format!("{}{}", "a".repeat(100), "你".repeat(100));
        let units = split_text_units(&mixed, 200).unwrap();
        assert_eq!(units[0].chars().count(), 150);
        assert_eq!(units.concat(), mixed);
    }

    #[test]
    fn a_cjk_unit_at_the_budget_fits_the_per_unit_token_cap() {
        use super::super::config::{GenerationControls, MAX_TEXT_UNIT_GENERATION_TOKENS};

        let text = "这是一个没有标点的很长的中文句子".repeat(20);
        for unit in split_text_units(&text, 200).unwrap() {
            // ~4-5 CJK characters per second at 12.5 codec frames per second
            // is at most ~3.1 frames per character.
            let expected_frames = unit.chars().count() * 25 / 8;
            assert!(expected_frames <= MAX_TEXT_UNIT_GENERATION_TOKENS as usize);
            let controls = GenerationControls::default().effective_for_text(
                &unit,
                "chinese",
                MAX_TEXT_UNIT_GENERATION_TOKENS,
            );
            assert!(controls.max_new_tokens as usize >= expected_frames);
        }
    }

    // `src/lib/qwenChunking.test.ts` pins the same inputs and outputs.
    #[test]
    fn parity_fixtures_shared_with_the_renderer() {
        let split = |text: &str| split_text_units(text, 200).unwrap();
        assert_eq!(split("Hello. World"), vec!["Hello.", " World"]);
        assert_eq!(split("One, two; three."), vec!["One, two; three."]);
        assert_eq!(split("Heading\nBody text"), vec!["Heading\n", "Body text"]);
        assert_eq!(
            split(&format!("{}。{}", "中".repeat(60), "文".repeat(60))),
            vec![format!("{}。", "中".repeat(60)), "文".repeat(60)]
        );
        assert_eq!(
            split(&"x".repeat(450)),
            vec!["x".repeat(200), "x".repeat(200), "x".repeat(50)]
        );
    }

    #[test]
    fn empty_or_zero_budget_is_rejected() {
        assert!(split_text_units("   ", 40).is_err());
        assert!(split_text_units("speech", 0).is_err());
    }
}
