//! Qwen3 request validation: the payload contract, mode and repository
//! agreement, and the voice-clone reference rules. Model-free, so the policy
//! tests pin every rejection without a tensor provider. Checks run in the order
//! the bridge has always applied them, so the first error a client sees for a
//! request with several problems does not change.

use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;
use serde_json::Value;

use super::config::{
    DEFAULT_CUSTOM_VOICE_LANGUAGE, DEFAULT_CUSTOM_VOICE_SPEAKER, GenerationControls,
    MAX_GENERATION_TOKENS,
};
use super::model_files::ExpectedModelType;
use crate::protocol::{
    MAX_LOCAL_TTS_TEXT_CHARS, MAX_REFERENCE_TEXT_CHARS, ensure_reference_audio_base64_len,
};

const MAX_REFERENCE_CACHE_KEY_CHARS: usize = 120;
const DEFAULT_TEMPERATURE: f64 = 0.9;
const DEFAULT_TOP_K: i64 = 50;
/// VoiceDesign and voice cloning let the model infer the language.
const DEFAULT_LANGUAGE: &str = "Auto";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Qwen3Payload {
    text: String,
    mode: Option<String>,
    model_repo: String,
    model_path: String,
    reference_audio_base64: Option<String>,
    reference_text: Option<String>,
    reference_cache_key: Option<String>,
    speaker: Option<String>,
    language: Option<String>,
    instruct: Option<String>,
    temperature: Option<f64>,
    top_k: Option<i64>,
    max_new_tokens: Option<i64>,
    seed: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Qwen3WarmPayload {
    mode: String,
    model_repo: Option<String>,
    model_path: String,
}

/// A warm-up request for one model directory in a known mode.
#[derive(Debug, PartialEq)]
pub struct WarmRequest {
    pub model_path: String,
    pub model_type: ExpectedModelType,
}

/// A generation request that passed every check that needs no model, with the
/// defaults for omitted fields filled in.
#[derive(Debug, PartialEq)]
pub struct GenerateRequest {
    /// Trimmed of outer whitespace.
    pub text: String,
    pub model_repo: String,
    pub model_path: String,
    pub language: String,
    pub controls: GenerationControls,
    pub mode: Mode,
}

#[derive(Debug, PartialEq)]
pub enum Mode {
    CustomVoice { speaker: String, instruct: String },
    VoiceDesign { instruct: String },
    VoiceClone(CloneReference),
}

#[derive(Debug, PartialEq)]
pub enum CloneReference {
    /// A new reference clip, still base64-encoded, with its exact transcript.
    Audio {
        wav_base64: String,
        transcript: String,
        session_key: Option<String>,
    },
    /// Features an earlier request prepared under this session key.
    Cached { session_key: String },
}

pub fn parse_warm_request(payload: Value) -> Result<WarmRequest> {
    let payload: Qwen3WarmPayload =
        serde_json::from_value(payload).context("Invalid Qwen3 warm payload")?;
    let model_type = parse_model_type(&payload.mode)?;
    if let Some(model_repo) = payload.model_repo.as_deref() {
        ensure_repo_matches_mode(model_repo, model_type)?;
    }
    Ok(WarmRequest {
        model_path: payload.model_path,
        model_type,
    })
}

pub fn parse_generate_request(payload: Value) -> Result<GenerateRequest> {
    let payload: Qwen3Payload = serde_json::from_value(payload).context("Invalid Qwen3 payload")?;
    ensure!(
        payload.temperature.is_none_or(f64::is_finite),
        "Qwen3 temperature must be finite."
    );
    let text = payload.text.trim();
    ensure!(
        !text.is_empty() && text.chars().count() <= MAX_LOCAL_TTS_TEXT_CHARS,
        "Qwen3 text must contain between 1 and {MAX_LOCAL_TTS_TEXT_CHARS} characters."
    );
    let text = text.to_owned();
    let model_type = parse_model_type(payload.mode.as_deref().unwrap_or("customVoice"))?;
    ensure_repo_matches_mode(&payload.model_repo, model_type)?;
    match model_type {
        ExpectedModelType::Base => ensure!(
            payload.speaker.is_none() && payload.instruct.is_none(),
            "Qwen3 voice cloning does not accept speaker or instruct."
        ),
        ExpectedModelType::CustomVoice => ensure!(
            payload.reference_text.is_none()
                && payload.reference_audio_base64.is_none()
                && payload.reference_cache_key.is_none(),
            "Qwen3 CustomVoice does not accept voice-clone reference fields."
        ),
        ExpectedModelType::VoiceDesign => ensure!(
            payload.speaker.is_none()
                && payload.reference_text.is_none()
                && payload.reference_audio_base64.is_none()
                && payload.reference_cache_key.is_none(),
            "Qwen3 VoiceDesign does not accept a speaker or voice-clone reference fields."
        ),
    }
    let controls = GenerationControls::new(
        payload.temperature.unwrap_or(DEFAULT_TEMPERATURE),
        payload.top_k.unwrap_or(DEFAULT_TOP_K),
        payload.max_new_tokens.unwrap_or(MAX_GENERATION_TOKENS),
    )
    .with_seed(payload.seed);
    let (mode, default_language) = match model_type {
        ExpectedModelType::CustomVoice => (
            Mode::CustomVoice {
                speaker: payload
                    .speaker
                    .unwrap_or_else(|| DEFAULT_CUSTOM_VOICE_SPEAKER.to_owned()),
                instruct: payload.instruct.unwrap_or_default(),
            },
            DEFAULT_CUSTOM_VOICE_LANGUAGE,
        ),
        ExpectedModelType::VoiceDesign => (
            Mode::VoiceDesign {
                instruct: payload.instruct.unwrap_or_default(),
            },
            DEFAULT_LANGUAGE,
        ),
        ExpectedModelType::Base => (
            Mode::VoiceClone(parse_clone_reference(
                payload.reference_audio_base64,
                payload.reference_text,
                payload.reference_cache_key,
            )?),
            DEFAULT_LANGUAGE,
        ),
    };
    Ok(GenerateRequest {
        text,
        model_repo: payload.model_repo,
        model_path: payload.model_path,
        language: payload
            .language
            .unwrap_or_else(|| default_language.to_owned()),
        controls,
        mode,
    })
}

fn parse_clone_reference(
    wav_base64: Option<String>,
    transcript: Option<String>,
    cache_key: Option<String>,
) -> Result<CloneReference> {
    if let Some(cache_key) = cache_key.as_deref() {
        validate_qwen_reference_cache_key(cache_key)?;
    }
    if let Some(wav_base64) = wav_base64 {
        let transcript = transcript
            .context("Qwen3 voice cloning requires referenceText with a reference WAV.")?;
        validate_qwen_reference_fields(&transcript, &wav_base64)?;
        return Ok(CloneReference::Audio {
            wav_base64,
            transcript,
            session_key: cache_key,
        });
    }
    ensure!(
        transcript.is_none(),
        "Qwen3 cached voice references do not accept referenceText without referenceAudioBase64."
    );
    Ok(CloneReference::Cached {
        session_key: cache_key
            .context("Qwen3 voice cloning requires referenceAudioBase64 or referenceCacheKey.")?,
    })
}

fn model_type_for_repo(model_repo: &str) -> ExpectedModelType {
    if model_repo.contains("-Base") {
        ExpectedModelType::Base
    } else if model_repo.contains("-VoiceDesign") {
        ExpectedModelType::VoiceDesign
    } else {
        ExpectedModelType::CustomVoice
    }
}

/// Warm-up and generation both key the resident host by model type, so a
/// repository that disagrees with the requested mode is rejected before any
/// weights are touched rather than at the first generation.
fn ensure_repo_matches_mode(model_repo: &str, model_type: ExpectedModelType) -> Result<()> {
    ensure!(
        model_type_for_repo(model_repo) == model_type,
        "Qwen3 model repository does not match the requested mode."
    );
    Ok(())
}

fn parse_model_type(mode: &str) -> Result<ExpectedModelType> {
    match mode {
        "customVoice" => Ok(ExpectedModelType::CustomVoice),
        "voiceClone" => Ok(ExpectedModelType::Base),
        "voiceDesign" => Ok(ExpectedModelType::VoiceDesign),
        _ => bail!("Unsupported Qwen3 mode: {mode}"),
    }
}

fn validate_qwen_reference_fields(reference_text: &str, encoded_audio: &str) -> Result<()> {
    let reference_text = reference_text.trim();
    ensure!(
        !reference_text.is_empty() && reference_text.chars().count() <= MAX_REFERENCE_TEXT_CHARS,
        "Qwen3 reference text must contain between 1 and {MAX_REFERENCE_TEXT_CHARS} characters."
    );
    let encoded_audio = encoded_audio.trim();
    ensure!(
        !encoded_audio.is_empty(),
        "Qwen3 voice cloning requires non-empty referenceAudioBase64."
    );
    ensure_reference_audio_base64_len(encoded_audio.len())
}

fn validate_qwen_reference_cache_key(cache_key: &str) -> Result<()> {
    ensure!(
        !cache_key.is_empty()
            && cache_key.len() <= MAX_REFERENCE_CACHE_KEY_CHARS
            && cache_key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
            && !cache_key.contains(".."),
        "Qwen3 referenceCacheKey has an invalid format."
    );
    Ok(())
}

/// Result warnings about the reference clip a voice-clone request used.
pub fn qwen_reference_warnings(truncated: bool, short: bool) -> Vec<String> {
    let mut warnings = Vec::new();
    if truncated {
        warnings.push("Qwen3 used only the first 20 seconds of the reference WAV.".to_string());
    }
    if short {
        warnings.push(
            "The reference WAV is shorter than 3 seconds, so the cloned voice may be inaccurate. Use a clear 3-20 second clip for best results."
                .to_string(),
        );
    }
    warnings
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CUSTOM_VOICE_REPO: &str = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit";
    const BASE_REPO: &str = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit";
    const VOICE_DESIGN_REPO: &str = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign";

    fn generate(fields: Value) -> Result<GenerateRequest> {
        let mut payload = json!({
            "text": "  Hello there.  ",
            "modelRepo": CUSTOM_VOICE_REPO,
            "modelPath": "/models/qwen",
        });
        for (key, value) in fields.as_object().unwrap() {
            payload[key] = value.clone();
        }
        parse_generate_request(payload)
    }

    fn clone_request(fields: Value) -> Result<GenerateRequest> {
        let mut payload = json!({ "mode": "voiceClone", "modelRepo": BASE_REPO });
        for (key, value) in fields.as_object().unwrap() {
            payload[key] = value.clone();
        }
        generate(payload)
    }

    fn error_of(result: Result<GenerateRequest>) -> String {
        result.unwrap_err().to_string()
    }

    #[test]
    fn qwen_payload_rejects_removed_controls() {
        let payload = json!({
            "text": "Hello",
            "modelRepo": CUSTOM_VOICE_REPO,
            "modelPath": "/model",
            "deviceMap": "auto",
        });
        assert!(serde_json::from_value::<Qwen3Payload>(payload).is_err());
    }

    #[test]
    fn qwen_reference_warnings_cover_trimmed_and_short_clips() {
        assert!(qwen_reference_warnings(false, false).is_empty());
        let warnings = qwen_reference_warnings(true, true);
        assert_eq!(warnings.len(), 2);
        assert!(warnings[0].contains("first 20 seconds"));
        assert!(warnings[1].contains("shorter than 3 seconds"));
    }

    #[test]
    fn qwen_payload_accepts_an_optional_sampling_seed() {
        let payload: Qwen3Payload = serde_json::from_value(json!({
            "text": "Hello",
            "modelRepo": CUSTOM_VOICE_REPO,
            "modelPath": "/model",
            "seed": 42,
        }))
        .unwrap();
        assert_eq!(payload.seed, Some(42));
        assert!(
            serde_json::from_value::<Qwen3Payload>(json!({
                "text": "Hello",
                "modelRepo": CUSTOM_VOICE_REPO,
                "modelPath": "/model",
                "seed": -1,
            }))
            .is_err()
        );
    }

    #[test]
    fn qwen_reference_fields_enforce_rust_transport_limits() {
        assert!(validate_qwen_reference_fields("matching words", "AQID").is_ok());
        assert!(
            validate_qwen_reference_fields(&"x".repeat(MAX_REFERENCE_TEXT_CHARS + 1), "AQID")
                .unwrap_err()
                .to_string()
                .contains("between 1 and 2000 characters")
        );
        assert!(validate_qwen_reference_cache_key("reader-job-1").is_ok());
        assert!(validate_qwen_reference_cache_key("bad/key").is_err());
        assert!(validate_qwen_reference_cache_key("a..b").is_err());
        assert!(validate_qwen_reference_cache_key("").is_err());
        assert!(validate_qwen_reference_cache_key(&"x".repeat(121)).is_err());
    }

    #[test]
    fn custom_voice_requests_resolve_defaults_and_trim_text() {
        let request = generate(json!({ "seed": 7 })).unwrap();
        assert_eq!(
            request,
            GenerateRequest {
                text: "Hello there.".to_string(),
                model_repo: CUSTOM_VOICE_REPO.to_string(),
                model_path: "/models/qwen".to_string(),
                language: DEFAULT_CUSTOM_VOICE_LANGUAGE.to_string(),
                controls: GenerationControls::new(0.9, 50, MAX_GENERATION_TOKENS)
                    .with_seed(Some(7)),
                mode: Mode::CustomVoice {
                    speaker: DEFAULT_CUSTOM_VOICE_SPEAKER.to_string(),
                    instruct: String::new(),
                },
            }
        );

        let explicit = generate(json!({
            "mode": "customVoice",
            "speaker": "Ryan",
            "language": "German",
            "instruct": "Calm",
            "temperature": 9.0,
            "topK": 0,
            "maxNewTokens": 128,
        }))
        .unwrap();
        assert_eq!(explicit.language, "German");
        assert_eq!(explicit.controls, GenerationControls::new(2.0, 1, 128));
        assert_eq!(
            explicit.mode,
            Mode::CustomVoice {
                speaker: "Ryan".to_string(),
                instruct: "Calm".to_string(),
            }
        );
    }

    #[test]
    fn voice_design_requests_default_to_auto_language() {
        let request = generate(json!({
            "mode": "voiceDesign",
            "modelRepo": VOICE_DESIGN_REPO,
            "instruct": "A warm narrator",
        }))
        .unwrap();
        assert_eq!(request.language, "Auto");
        assert_eq!(
            request.mode,
            Mode::VoiceDesign {
                instruct: "A warm narrator".to_string(),
            }
        );
    }

    #[test]
    fn clone_requests_take_new_audio_or_a_cached_session() {
        let audio = clone_request(json!({
            "referenceAudioBase64": " UklGRg== ",
            "referenceText": "Exact words.",
            "referenceCacheKey": "job-1",
        }))
        .unwrap();
        assert_eq!(audio.language, "Auto");
        assert_eq!(
            audio.mode,
            Mode::VoiceClone(CloneReference::Audio {
                wav_base64: " UklGRg== ".to_string(),
                transcript: "Exact words.".to_string(),
                session_key: Some("job-1".to_string()),
            })
        );

        let cached = clone_request(json!({ "referenceCacheKey": "job-1" })).unwrap();
        assert_eq!(
            cached.mode,
            Mode::VoiceClone(CloneReference::Cached {
                session_key: "job-1".to_string(),
            })
        );
    }

    #[test]
    fn clone_requests_reject_inconsistent_reference_fields() {
        assert_eq!(
            error_of(clone_request(json!({ "referenceAudioBase64": "UklGRg==" }))),
            "Qwen3 voice cloning requires referenceText with a reference WAV."
        );
        assert_eq!(
            error_of(clone_request(json!({ "referenceText": "Exact words." }))),
            "Qwen3 cached voice references do not accept referenceText without referenceAudioBase64."
        );
        assert_eq!(
            error_of(clone_request(json!({}))),
            "Qwen3 voice cloning requires referenceAudioBase64 or referenceCacheKey."
        );
        assert_eq!(
            error_of(clone_request(json!({
                "referenceCacheKey": "../escape",
                "referenceAudioBase64": "UklGRg==",
            }))),
            "Qwen3 referenceCacheKey has an invalid format."
        );
        assert_eq!(
            error_of(clone_request(json!({
                "referenceAudioBase64": "   ",
                "referenceText": "Exact words.",
            }))),
            "Qwen3 voice cloning requires non-empty referenceAudioBase64."
        );
        assert_eq!(
            error_of(clone_request(json!({
                "referenceCacheKey": "job-1",
                "speaker": "Ryan",
            }))),
            "Qwen3 voice cloning does not accept speaker or instruct."
        );
    }

    #[test]
    fn requests_reject_fields_from_another_mode() {
        assert_eq!(
            error_of(generate(json!({ "referenceCacheKey": "job-1" }))),
            "Qwen3 CustomVoice does not accept voice-clone reference fields."
        );
        assert_eq!(
            error_of(generate(json!({
                "mode": "voiceDesign",
                "modelRepo": VOICE_DESIGN_REPO,
                "speaker": "Ryan",
            }))),
            "Qwen3 VoiceDesign does not accept a speaker or voice-clone reference fields."
        );
    }

    #[test]
    fn requests_validate_text_mode_and_repository_in_order() {
        assert_eq!(
            error_of(generate(json!({ "text": "   " }))),
            "Qwen3 text must contain between 1 and 6000 characters."
        );
        assert_eq!(
            error_of(generate(json!({ "text": "a".repeat(6_001) }))),
            "Qwen3 text must contain between 1 and 6000 characters."
        );
        // Outer whitespace does not count toward the limit.
        assert!(generate(json!({ "text": format!("  {}  ", "a".repeat(6_000)) })).is_ok());
        assert_eq!(
            error_of(generate(json!({ "mode": "karaoke" }))),
            "Unsupported Qwen3 mode: karaoke"
        );
        assert_eq!(
            error_of(generate(json!({ "mode": "voiceClone" }))),
            "Qwen3 model repository does not match the requested mode."
        );
        // An empty text is reported before a mismatched mode.
        assert_eq!(
            error_of(generate(json!({ "text": "", "mode": "voiceClone" }))),
            "Qwen3 text must contain between 1 and 6000 characters."
        );
        assert_eq!(
            error_of(generate(json!({ "deviceMap": "auto" }))),
            "Invalid Qwen3 payload"
        );
    }

    #[test]
    fn warm_requests_name_a_mode_and_an_optional_matching_repository() {
        assert_eq!(
            parse_warm_request(json!({ "mode": "voiceClone", "modelPath": "/models/base" }))
                .unwrap(),
            WarmRequest {
                model_path: "/models/base".to_string(),
                model_type: ExpectedModelType::Base,
            }
        );
        assert!(
            parse_warm_request(json!({
                "mode": "voiceDesign",
                "modelRepo": VOICE_DESIGN_REPO,
                "modelPath": "/models/design",
            }))
            .is_ok()
        );
        assert_eq!(
            parse_warm_request(json!({
                "mode": "customVoice",
                "modelRepo": BASE_REPO,
                "modelPath": "/models/base",
            }))
            .unwrap_err()
            .to_string(),
            "Qwen3 model repository does not match the requested mode."
        );
        assert_eq!(
            parse_warm_request(json!({ "mode": "customVoice" }))
                .unwrap_err()
                .to_string(),
            "Invalid Qwen3 warm payload"
        );
    }
}
