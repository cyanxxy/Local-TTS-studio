//! NeuTTS request validation: the payload contract, the repository allow-list,
//! and the bounds on pre-encoded `.npy` references. Model-free, so the policy
//! tests cover every rule without llama.cpp.

use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;
use serde_json::Value;

use crate::protocol::{MAX_LOCAL_TTS_TEXT_CHARS, MAX_REFERENCE_TEXT_CHARS};

pub const NEUTTS_DEFAULT_MODEL: &str = "neuphonic/neutts-nano-q4-gguf";
const ALLOWED_NEUTTS_MODELS: [&str; 6] = [
    "neuphonic/neutts-nano-q4-gguf",
    "neuphonic/neutts-air-q4-gguf",
    "neuphonic/neutts-air-q8-gguf",
    "neuphonic/neutts-nano-german-q4-gguf",
    "neuphonic/neutts-nano-french-q4-gguf",
    "neuphonic/neutts-nano-spanish-q4-gguf",
];
pub const MAX_NEUTTS_REFERENCE_CODES: usize = 1_000;
pub const MAX_NEUTTS_REFERENCE_CODE_VALUE: i32 = 65_535;
pub const MAX_NEUTTS_REFERENCE_CODES_FILE_BYTES: usize = 64 * 1_024;
pub const MAX_NEUTTS_REFERENCE_CODES_BASE64_CHARS: usize =
    MAX_NEUTTS_REFERENCE_CODES_FILE_BYTES.div_ceil(3) * 4;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NeuttsPayload {
    text: String,
    reference_text: String,
    reference_codes_base64: Option<String>,
    reference_audio_base64: Option<String>,
    model_repo: Option<String>,
}

/// A NeuTTS request that passed every check that needs no model.
#[derive(Debug, PartialEq)]
pub struct NeuttsRequest {
    pub text: String,
    pub reference_text: String,
    pub model_repo: String,
    pub reference: NeuttsReference,
}

/// The voice reference, still base64-encoded.
#[derive(Debug, PartialEq)]
pub enum NeuttsReference {
    /// Pre-encoded NeuCodec codes as a `.npy` file.
    Codes(String),
    /// A WAV clip for the NeuCodec encoder.
    Audio(String),
}

pub fn parse_neutts_request(payload: Value) -> Result<NeuttsRequest> {
    let payload: NeuttsPayload =
        serde_json::from_value(payload).context("Invalid NeuTTS payload")?;
    ensure!(
        !payload.text.trim().is_empty(),
        "Text to synthesize is empty."
    );
    ensure!(
        payload.text.chars().count() <= MAX_LOCAL_TTS_TEXT_CHARS,
        "NeuTTS text exceeds {MAX_LOCAL_TTS_TEXT_CHARS} characters."
    );
    ensure!(
        !payload.reference_text.trim().is_empty()
            && payload.reference_text.chars().count() <= MAX_REFERENCE_TEXT_CHARS,
        "NeuTTS reference text must contain between 1 and {MAX_REFERENCE_TEXT_CHARS} characters."
    );
    let model_repo = normalize_neutts_model(payload.model_repo.as_deref())?;
    let reference_codes = payload
        .reference_codes_base64
        .filter(|encoded| !encoded.trim().is_empty());
    let reference_audio = payload
        .reference_audio_base64
        .filter(|encoded| !encoded.trim().is_empty());
    let reference = match (reference_codes, reference_audio) {
        (Some(_), Some(_)) => {
            bail!("Provide either NeuTTS reference codes or reference audio, not both.")
        }
        (Some(encoded), None) => NeuttsReference::Codes(encoded),
        (None, Some(encoded)) => NeuttsReference::Audio(encoded),
        (None, None) => bail!(
            "Provide a reference: either pre-encoded .npy codes (referenceCodesBase64) or a WAV clip (referenceAudioBase64)."
        ),
    };
    Ok(NeuttsRequest {
        text: payload.text,
        reference_text: payload.reference_text,
        model_repo,
        reference,
    })
}

pub fn normalize_neutts_model(input: Option<&str>) -> Result<String> {
    let model = input.unwrap_or(NEUTTS_DEFAULT_MODEL);
    if ALLOWED_NEUTTS_MODELS.contains(&model) {
        Ok(model.to_string())
    } else {
        bail!("Unsupported Rust NeuTTS model repository: {model}")
    }
}

pub fn ensure_neutts_codes_base64_len(encoded_len: usize) -> Result<()> {
    ensure!(
        encoded_len <= MAX_NEUTTS_REFERENCE_CODES_BASE64_CHARS,
        "NeuTTS reference-code payload exceeds the {MAX_NEUTTS_REFERENCE_CODES_FILE_BYTES}-byte .npy limit."
    );
    Ok(())
}

/// Check a `.npy` header and payload size before the upstream parser sees the
/// bytes, so its shape products and size arithmetic cannot overflow.
pub fn prevalidate_neutts_npy(raw: &[u8]) -> Result<()> {
    ensure!(
        raw.len() <= MAX_NEUTTS_REFERENCE_CODES_FILE_BYTES,
        "NeuTTS reference .npy exceeds the {MAX_NEUTTS_REFERENCE_CODES_FILE_BYTES}-byte limit."
    );
    ensure!(
        raw.len() >= 10 && &raw[..6] == b"\x93NUMPY",
        "NeuTTS reference is not a valid .npy file."
    );

    let (header_len, header_start) = match raw[6] {
        1 => (u16::from_le_bytes([raw[8], raw[9]]) as usize, 10usize),
        2 => {
            ensure!(
                raw.len() >= 12,
                "NeuTTS reference .npy v2 header is truncated."
            );
            (
                u32::from_le_bytes([raw[8], raw[9], raw[10], raw[11]]) as usize,
                12usize,
            )
        }
        major => bail!("Unsupported NeuTTS reference .npy version {major}."),
    };
    let header_end = header_start
        .checked_add(header_len)
        .context("NeuTTS reference .npy header length overflowed")?;
    ensure!(
        header_end <= raw.len(),
        "NeuTTS reference .npy header is truncated."
    );
    let header = std::str::from_utf8(&raw[header_start..header_end])
        .context("NeuTTS reference .npy header is not valid UTF-8")?;
    let shape = extract_npy_header_field(header, "shape")
        .context("NeuTTS reference .npy header is missing 'shape'")?;
    let shape = shape
        .strip_prefix('(')
        .and_then(|value| value.strip_suffix(')'))
        .context("NeuTTS reference .npy shape must be a tuple")?;

    let mut element_count = 1usize;
    for dimension in shape
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let dimension = dimension.parse::<usize>().with_context(|| {
            format!("Invalid NeuTTS reference .npy shape dimension '{dimension}'")
        })?;
        element_count = element_count
            .checked_mul(dimension)
            .context("NeuTTS reference .npy shape dimensions overflowed")?;
    }
    ensure!(
        (1..=MAX_NEUTTS_REFERENCE_CODES).contains(&element_count),
        "NeuTTS reference .npy must contain between 1 and {MAX_NEUTTS_REFERENCE_CODES} codes."
    );

    // The only dtypes accepted by neutts::npy are four bytes wide. Checking
    // this before calling its parser guarantees its internal shape products
    // and byte-size arithmetic cannot overflow, even for hostile headers.
    let data_bytes = element_count
        .checked_mul(4)
        .context("NeuTTS reference .npy data size overflowed")?;
    let required_len = header_end
        .checked_add(data_bytes)
        .context("NeuTTS reference .npy total size overflowed")?;
    ensure!(
        required_len <= raw.len(),
        "NeuTTS reference .npy data section is truncated."
    );
    Ok(())
}

fn extract_npy_header_field<'a>(header: &'a str, field: &str) -> Option<&'a str> {
    let single_quoted_key = format!("'{field}':");
    let double_quoted_key = format!("\"{field}\":");
    let start = header
        .find(&single_quoted_key)
        .map(|position| position + single_quoted_key.len())
        .or_else(|| {
            header
                .find(&double_quoted_key)
                .map(|position| position + double_quoted_key.len())
        })?;
    let value = header[start..].trim_start();
    if value.starts_with('(') {
        let end = value.find(')')?;
        Some(&value[..=end])
    } else {
        None
    }
}

/// Convert `.npy` float codes, which must be whole numbers in the code range.
pub fn neutts_codes_from_f32(data: Vec<f32>) -> Result<Vec<i32>> {
    let mut codes = Vec::with_capacity(data.len());
    for code in data {
        ensure!(
            code.is_finite() && code.fract() == 0.0,
            "NeuTTS reference .npy float codes must be finite whole numbers."
        );
        ensure!(
            (0.0..=MAX_NEUTTS_REFERENCE_CODE_VALUE as f32).contains(&code),
            "NeuTTS reference codes must be between 0 and {MAX_NEUTTS_REFERENCE_CODE_VALUE}."
        );
        #[expect(
            clippy::cast_possible_truncation,
            reason = "checked above: a whole number within the reference code range"
        )]
        codes.push(code as i32);
    }
    Ok(codes)
}

pub fn validate_neutts_reference_codes(codes: &[i32]) -> Result<()> {
    ensure!(
        (1..=MAX_NEUTTS_REFERENCE_CODES).contains(&codes.len()),
        "NeuTTS reference .npy must contain between 1 and {MAX_NEUTTS_REFERENCE_CODES} codes."
    );
    ensure!(
        codes
            .iter()
            .all(|code| (0..=MAX_NEUTTS_REFERENCE_CODE_VALUE).contains(code)),
        "NeuTTS reference codes must be between 0 and {MAX_NEUTTS_REFERENCE_CODE_VALUE}."
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn npy_with_header(major: u8, header: &str, data: &[u8]) -> Vec<u8> {
        let mut bytes = b"\x93NUMPY".to_vec();
        bytes.extend_from_slice(&[major, 0]);
        match major {
            1 => bytes.extend_from_slice(&u16::try_from(header.len()).unwrap().to_le_bytes()),
            _ => bytes.extend_from_slice(&u32::try_from(header.len()).unwrap().to_le_bytes()),
        }
        bytes.extend_from_slice(header.as_bytes());
        bytes.extend_from_slice(data);
        bytes
    }

    fn i32_header(shape: &str) -> String {
        format!("{{'descr': '<i4', 'fortran_order': False, 'shape': {shape}, }}\n")
    }

    fn payload(fields: Value) -> Value {
        let mut payload = json!({
            "text": "Hello there.",
            "referenceText": "A reference transcript.",
            "referenceCodesBase64": "k05VTVBZ",
        });
        for (key, value) in fields.as_object().unwrap() {
            payload[key] = value.clone();
        }
        payload
    }

    #[test]
    fn normalize_neutts_model_enforces_allowlist() {
        assert_eq!(normalize_neutts_model(None).unwrap(), NEUTTS_DEFAULT_MODEL);
        assert!(normalize_neutts_model(Some("neuphonic/neutts-nano-q4-gguf")).is_ok());
        assert!(normalize_neutts_model(Some("neuphonic/neutts-air-q4-gguf")).is_ok());
        assert!(normalize_neutts_model(Some("neuphonic/neutts-air-q8-gguf")).is_ok());
        for model in [
            "neuphonic/neutts-nano-q8-gguf",
            "neuphonic/neutts-nano-german-q8-gguf",
            "neuphonic/neutts-nano-french-q8-gguf",
            "neuphonic/neutts-nano-spanish-q8-gguf",
        ] {
            assert!(normalize_neutts_model(Some(model)).is_err());
        }
        assert!(normalize_neutts_model(Some("evil/model")).is_err());
    }

    #[test]
    fn requests_carry_exactly_one_reference() {
        let request = parse_neutts_request(payload(json!({}))).unwrap();
        assert_eq!(
            request,
            NeuttsRequest {
                text: "Hello there.".to_string(),
                reference_text: "A reference transcript.".to_string(),
                model_repo: NEUTTS_DEFAULT_MODEL.to_string(),
                reference: NeuttsReference::Codes("k05VTVBZ".to_string()),
            }
        );

        // A blank field counts as absent, so it neither satisfies nor
        // conflicts with the other reference kind.
        let audio = parse_neutts_request(payload(json!({
            "referenceCodesBase64": "  ",
            "referenceAudioBase64": "UklGRg==",
        })))
        .unwrap();
        assert_eq!(
            audio.reference,
            NeuttsReference::Audio("UklGRg==".to_string())
        );

        let both = parse_neutts_request(payload(json!({ "referenceAudioBase64": "UklGRg==" })));
        assert!(both.unwrap_err().to_string().contains("not both"));
        let neither = parse_neutts_request(payload(json!({ "referenceCodesBase64": null })));
        assert!(
            neither
                .unwrap_err()
                .to_string()
                .contains("Provide a reference")
        );
    }

    #[test]
    fn requests_enforce_text_bounds_and_the_payload_contract() {
        let blank = parse_neutts_request(payload(json!({ "text": "   " })));
        assert_eq!(
            blank.unwrap_err().to_string(),
            "Text to synthesize is empty."
        );
        let long = parse_neutts_request(payload(json!({ "text": "a".repeat(6_001) })));
        assert!(long.unwrap_err().to_string().contains("exceeds 6000"));
        let transcript = parse_neutts_request(payload(json!({ "referenceText": "" })));
        assert!(
            transcript
                .unwrap_err()
                .to_string()
                .contains("between 1 and 2000")
        );
        let unknown = parse_neutts_request(payload(json!({ "speaker": "Aiden" })));
        assert_eq!(unknown.unwrap_err().to_string(), "Invalid NeuTTS payload");
        let model = parse_neutts_request(payload(json!({ "modelRepo": "evil/model" })));
        assert!(
            model
                .unwrap_err()
                .to_string()
                .contains("Unsupported Rust NeuTTS model")
        );
    }

    #[test]
    fn npy_prevalidation_accepts_bounded_v1_and_v2_files() {
        let data = [0_u8; 12];
        assert!(prevalidate_neutts_npy(&npy_with_header(1, &i32_header("(3,)"), &data)).is_ok());
        assert!(prevalidate_neutts_npy(&npy_with_header(2, &i32_header("(1, 3)"), &data)).is_ok());
    }

    #[test]
    fn npy_prevalidation_rejects_hostile_headers_before_parsing() {
        let overflow = npy_with_header(1, &i32_header(&format!("({}, 2)", usize::MAX)), &[]);
        assert!(
            prevalidate_neutts_npy(&overflow)
                .unwrap_err()
                .to_string()
                .contains("shape dimensions overflowed")
        );
        let too_many = npy_with_header(1, &i32_header("(1001,)"), &[0; 4_004]);
        assert!(
            prevalidate_neutts_npy(&too_many)
                .unwrap_err()
                .to_string()
                .contains("between 1 and 1000 codes")
        );
        let short_data = npy_with_header(1, &i32_header("(3,)"), &[0; 8]);
        assert!(
            prevalidate_neutts_npy(&short_data)
                .unwrap_err()
                .to_string()
                .contains("data section is truncated")
        );
        let mut truncated_header = npy_with_header(1, &i32_header("(3,)"), &[]);
        truncated_header.truncate(20);
        assert!(
            prevalidate_neutts_npy(&truncated_header)
                .unwrap_err()
                .to_string()
                .contains("header is truncated")
        );
        let no_shape = npy_with_header(1, "{'descr': '<i4'}", &[0; 4]);
        assert!(
            prevalidate_neutts_npy(&no_shape)
                .unwrap_err()
                .to_string()
                .contains("missing 'shape'")
        );
        let version_three = npy_with_header(3, &i32_header("(1,)"), &[0; 4]);
        assert!(
            prevalidate_neutts_npy(&version_three)
                .unwrap_err()
                .to_string()
                .contains("version 3")
        );
        assert!(prevalidate_neutts_npy(b"not numpy").is_err());
        let oversized = vec![0_u8; MAX_NEUTTS_REFERENCE_CODES_FILE_BYTES + 1];
        assert!(
            prevalidate_neutts_npy(&oversized)
                .unwrap_err()
                .to_string()
                .contains("65536-byte limit")
        );
        assert!(ensure_neutts_codes_base64_len(MAX_NEUTTS_REFERENCE_CODES_BASE64_CHARS).is_ok());
        assert!(
            ensure_neutts_codes_base64_len(MAX_NEUTTS_REFERENCE_CODES_BASE64_CHARS + 1).is_err()
        );
    }

    #[test]
    fn float_codes_must_be_whole_numbers_in_range() {
        assert_eq!(
            neutts_codes_from_f32(vec![0.0, 42.0, 65_535.0]).unwrap(),
            vec![0, 42, 65_535]
        );
        for code in [0.5, f32::NAN, f32::INFINITY] {
            assert!(
                neutts_codes_from_f32(vec![code])
                    .unwrap_err()
                    .to_string()
                    .contains("finite whole numbers")
            );
        }
        for code in [-1.0, 65_536.0] {
            assert!(
                neutts_codes_from_f32(vec![code])
                    .unwrap_err()
                    .to_string()
                    .contains("between 0 and 65535")
            );
        }
    }

    #[test]
    fn decoded_codes_are_bounded_in_count_and_value() {
        assert!(validate_neutts_reference_codes(&[0, 65_535]).is_ok());
        assert!(validate_neutts_reference_codes(&[]).is_err());
        assert!(validate_neutts_reference_codes(&vec![0; MAX_NEUTTS_REFERENCE_CODES + 1]).is_err());
        assert!(
            validate_neutts_reference_codes(&[-1])
                .unwrap_err()
                .to_string()
                .contains("between 0 and 65535")
        );
    }
}
