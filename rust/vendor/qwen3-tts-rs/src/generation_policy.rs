// Qwen generation policy, kept independent of tensor backends so the bridge
// regression suite can verify parity without loading model weights.
// Match Transformers' repetition processor and Qwen's reserved-token mask.
pub(crate) fn process_codec_logits(logits: &mut [f32], past_codes: &[i64], penalty: f64, eos: i64) {
    let mut seen = vec![false; logits.len()];
    for &code in past_codes {
        let Ok(index) = usize::try_from(code) else {
            continue;
        };
        if index < logits.len() && !seen[index] {
            seen[index] = true;
            logits[index] = if logits[index] > 0.0 {
                logits[index] / penalty as f32
            } else {
                logits[index] * penalty as f32
            };
        }
    }
    let reserved_start = logits.len().saturating_sub(1024);
    for (index, score) in logits.iter_mut().enumerate() {
        if (index >= reserved_start && index as i64 != eos)
            || (index as i64 == eos && past_codes.len() < 2)
        {
            *score = f32::NEG_INFINITY;
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn codec_prompt_prefix(
    language_id: Option<i64>,
    speaker_id: Option<i64>,
    think: i64,
    nothink: i64,
    think_bos: i64,
    think_eos: i64,
    pad: i64,
    bos: i64,
) -> Vec<i64> {
    let mut tokens = match language_id {
        Some(language) => vec![think, think_bos, language, think_eos],
        None => vec![nothink, think_bos, think_eos],
    };
    if let Some(speaker) = speaker_id {
        tokens.push(speaker);
    }
    tokens.extend_from_slice(&[pad, bos]);
    tokens
}

pub(crate) fn custom_voice_instruction<'a>(model_size: Option<&str>, instruct: &'a str) -> &'a str {
    if model_size == Some("0b6") {
        ""
    } else {
        instruct
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codec_prompts_match_upstream_language_and_speaker_layouts() {
        use super::codec_prompt_prefix;
        assert_eq!(
            codec_prompt_prefix(None, Some(9), 1, 2, 3, 4, 5, 6),
            vec![2, 3, 4, 9, 5, 6]
        );
        assert_eq!(
            codec_prompt_prefix(Some(8), Some(9), 1, 2, 3, 4, 5, 6),
            vec![1, 3, 8, 4, 9, 5, 6]
        );
        assert_eq!(
            codec_prompt_prefix(None, None, 1, 2, 3, 4, 5, 6),
            vec![2, 3, 4, 5, 6]
        );
    }

    #[test]
    fn codec_sampling_matches_reserved_mask_and_unique_penalties() {
        let mut scores = vec![2.0; 3072];
        scores[7] = -2.0;
        process_codec_logits(&mut scores, &[5, 5, 7, 7], 2.0, 2150);
        assert_eq!(scores[5], 1.0);
        assert_eq!(scores[7], -4.0);
        assert_eq!(scores[2047], 2.0);
        assert_eq!(scores[2048], f32::NEG_INFINITY);
        assert_eq!(scores[2150], 2.0);
        assert_eq!(scores[3071], f32::NEG_INFINITY);
        process_codec_logits(&mut scores, &[], 1.0, 2150);
        assert_eq!(scores[2150], f32::NEG_INFINITY);
    }

    #[test]
    fn small_custom_voice_does_not_accept_instruction_conditioning() {
        assert_eq!(custom_voice_instruction(Some("0b6"), "happy"), "");
        assert_eq!(custom_voice_instruction(Some("1b7"), "happy"), "happy");
    }
}
