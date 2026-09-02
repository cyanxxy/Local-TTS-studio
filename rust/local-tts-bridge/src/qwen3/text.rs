use anyhow::{Result, ensure};

const SENTENCE_BOUNDARIES: &[char] = &['.', '!', '?', '。', '！', '？', '；', ';', '\n'];
const CLAUSE_BOUNDARIES: &[char] = &[',', ':', '，', '：', '、'];

/// Weight of one CJK scalar toward the unit budget. CJK scripts carry roughly
/// one syllable per character where Latin text carries one per several, so a
/// CJK unit at the full character budget would need far more codec frames
/// than a Latin one. Counting CJK twice keeps a unit's spoken length, and so
/// its generation budget, in the same range for both.
pub const CJK_CHAR_WEIGHT: usize = 2;

/// Mirrored by `buildQwen3TextUnits` in `src/lib/qwenChunking.ts`. Both sides
/// must produce identical unit boundaries: the renderer maps Rust's
/// `textUnitIndex` onto units it computed itself.
pub fn split_text_units(text: &str, max_chars: usize) -> Result<Vec<String>> {
    ensure!(max_chars > 0, "Qwen3 text-unit budget must be positive.");
    ensure!(!text.trim().is_empty(), "Qwen3 text is empty.");

    let mut units = Vec::new();
    let mut start = 0usize;
    while start < text.len() {
        let mut weight = 0usize;
        let mut preferred_end = None;
        let mut hard_end = text.len();
        let mut previous = None;

        let mut chars = text[start..].char_indices().peekable();
        while let Some((relative_offset, ch)) = chars.next() {
            weight += char_weight(ch);
            let end = start + relative_offset + ch.len_utf8();
            let next = chars.peek().map(|(_, next)| *next);
            if is_boundary(ch, previous, next) {
                preferred_end = Some(end);
            }
            if weight >= max_chars {
                hard_end = end;
                break;
            }
            previous = Some(ch);
        }

        let end = preferred_end.unwrap_or(hard_end);
        ensure!(end > start, "Qwen3 text splitter made no progress.");
        units.push(text[start..end].to_owned());
        start = end;
    }

    Ok(units)
}

pub fn char_weight(ch: char) -> usize {
    if is_cjk(ch) { CJK_CHAR_WEIGHT } else { 1 }
}

/// Punctuation between two ASCII digits ("3.14", "1,000", "10:30") is part of
/// a number, not a place to pause.
fn is_boundary(ch: char, previous: Option<char>, next: Option<char>) -> bool {
    if !(SENTENCE_BOUNDARIES.contains(&ch) || CLAUSE_BOUNDARIES.contains(&ch)) {
        return false;
    }
    let between_digits =
        previous.is_some_and(|c| c.is_ascii_digit()) && next.is_some_and(|c| c.is_ascii_digit());
    !between_digits
}

pub fn is_cjk(character: char) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cjk_without_spaces_never_slices_utf8_or_loses_text() {
        let text = "你好世界。".repeat(240);
        let units = split_text_units(&text, 120).unwrap();
        // Ideographs weigh 2 and the full stop 1, so 13 sentences (65
        // scalars, weight 117) fit a 120 budget.
        assert!(units.iter().all(|unit| unit.chars().count() <= 65));
        assert_eq!(units.len(), 19);
        assert!(units.iter().all(|unit| unit.ends_with('。')));
        assert_eq!(units.concat(), text);
    }

    #[test]
    fn latin_text_uses_the_full_budget() {
        let text = "a".repeat(300);
        let units = split_text_units(&text, 200).unwrap();
        assert_eq!(
            units
                .iter()
                .map(|unit| unit.chars().count())
                .collect::<Vec<_>>(),
            vec![200, 100]
        );
    }

    #[test]
    fn emoji_combining_marks_and_long_urls_round_trip() {
        let text = "Ame\u{301}lie🙂 https://example.test/".to_string() + &"路".repeat(300);
        let units = split_text_units(&text, 64).unwrap();
        assert!(units.iter().all(|unit| unit.chars().count() <= 64));
        assert_eq!(units.concat(), text);
    }

    #[test]
    fn punctuation_inside_numbers_is_not_a_boundary() {
        let text = format!(
            "Pi is 3.14159 and the total is 1,000 at 10:30. {}",
            "x".repeat(40)
        );
        let units = split_text_units(&text, 50).unwrap();
        assert_eq!(units[0], "Pi is 3.14159 and the total is 1,000 at 10:30.");
        assert_eq!(units.concat(), text);
    }

    #[test]
    fn empty_or_zero_budget_is_rejected() {
        assert!(split_text_units("   ", 40).is_err());
        assert!(split_text_units("speech", 0).is_err());
    }
}
