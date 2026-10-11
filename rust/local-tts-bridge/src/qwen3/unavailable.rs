//! Qwen3 on a target without a packaged tensor provider. The bridge still
//! starts, probes, and answers requests, so Electron reports the platform gap
//! rather than a dead process.

use anyhow::{Result, bail};
use serde_json::{Value, json};

use crate::protocol::GenerationOutput;
use crate::ws::{Backend, WebSocketConnection};

const UNAVAILABLE_MESSAGE: &str = "Qwen3 is unavailable on this platform.";

#[derive(Default)]
pub struct Qwen3Backend;

impl Qwen3Backend {
    pub fn new() -> Self {
        Self
    }
}

impl Backend for Qwen3Backend {
    fn warm(&mut self, _payload: Value) -> Result<Value> {
        bail!("{UNAVAILABLE_MESSAGE}")
    }

    fn generate(
        &mut self,
        _request_id: &str,
        _payload: Value,
        _connection: &mut WebSocketConnection,
    ) -> Result<GenerationOutput> {
        bail!("{UNAVAILABLE_MESSAGE}")
    }
}

pub fn probe_result() -> Value {
    json!({
        "ready": false,
        "message": "Qwen3-TTS is supported only on Apple Silicon macOS and Windows.",
        "runtime": "rust",
        "package": "qwen3-tts-rs",
        "packageVersion": super::PACKAGE_VERSION,
        "upstreamRevision": super::UPSTREAM_REVISION,
        "provider": "unsupported",
        "device": "unavailable",
        "accelerated": false,
        "warnings": ["This platform has no packaged Qwen3 tensor provider."],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warm_requests_report_the_missing_provider() {
        let error = Qwen3Backend::new().warm(json!({})).unwrap_err();
        assert_eq!(error.to_string(), UNAVAILABLE_MESSAGE);
    }

    #[test]
    fn probe_reports_an_unsupported_platform() {
        let probe = probe_result();
        assert_eq!(probe["ready"], false);
        assert_eq!(probe["provider"], "unsupported");
        assert_eq!(probe["device"], "unavailable");
        assert_eq!(probe["packageVersion"], super::super::PACKAGE_VERSION);
        assert_eq!(probe["upstreamRevision"], super::super::UPSTREAM_REVISION);
    }
}
