use anyhow::{Result, ensure};

const SENTENCE_BOUNDARIES: &[char] = &['.', '!', '?', '。', '！', '？', '；', ';', '\n'];
const CLAUSE_BOUNDARIES: &[char] = &[',', ':', '，', '：', '、'];

pub fn split_text_units(text: &str, max_chars: usize) -> Result<Vec<String>> {
    ensure!(max_chars > 0, "Qwen3 text-unit budget must be positive.");
    ensure!(!text.trim().is_empty(), "Qwen3 text is empty.");

    let mut units = Vec::new();
    let mut start = 0usize;
    while start < text.len() {
        let mut char_count = 0usize;
        let mut preferred_end = None;
        let mut hard_end = text.len();

        for (relative_offset, ch) in text[start..].char_indices() {
            char_count += 1;
            let end = start + relative_offset + ch.len_utf8();
            if SENTENCE_BOUNDARIES.contains(&ch) || CLAUSE_BOUNDARIES.contains(&ch) {
                preferred_end = Some(end);
            }
            if char_count == max_chars {
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
    fn empty_or_zero_budget_is_rejected() {
        assert!(split_text_units("   ", 40).is_err());
        assert!(split_text_units("speech", 0).is_err());
    }
}
