//! The HTTP upgrade: read one bounded request, admit only the process owner's
//! token, and answer every refusal with a plain HTTP status.

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};
use tungstenite::handshake::machine::TryParse;
use tungstenite::handshake::server::{Request, Response, write_response};
use tungstenite::http::StatusCode;

const MAX_WEBSOCKET_HANDSHAKE_BYTES: usize = 64 * 1024;
const WEBSOCKET_HANDSHAKE_DEADLINE_SEC: u64 = 10;

/// Read the upgrade request, returning it with any bytes the client sent after
/// it (a pipelined first frame belongs to the WebSocket stream).
pub fn read_websocket_upgrade<S: Read + Write>(stream: &mut S) -> Result<(Request, Vec<u8>)> {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 1_024];
    let deadline = Instant::now() + Duration::from_secs(WEBSOCKET_HANDSHAKE_DEADLINE_SEC);
    loop {
        if Instant::now() > deadline {
            let _ = write_websocket_error_response(stream, StatusCode::REQUEST_TIMEOUT);
            bail!("WebSocket handshake exceeded the total handshake deadline.");
        }
        let read = stream.read(&mut buffer)?;
        ensure!(read > 0, "WebSocket client disconnected during handshake.");
        request.extend_from_slice(&buffer[..read]);
        if request.len() > MAX_WEBSOCKET_HANDSHAKE_BYTES {
            let _ = write_websocket_error_response(stream, StatusCode::PAYLOAD_TOO_LARGE);
            bail!("WebSocket handshake exceeded the maximum header size.");
        }
        if let Some((header_len, parsed)) =
            Request::try_parse(&request).context("Invalid WebSocket handshake request")?
        {
            let tail = request.split_off(header_len);
            return Ok((parsed, tail));
        }
    }
}

pub fn websocket_request_path_is_authorized(request: &Request, auth_token: &str) -> bool {
    // WebSocket upgrades are exempt from CORS, so a page in any browser can
    // reach a loopback listener. The path token already makes that useless, but
    // the only legitimate client here is Electron's main process, which never
    // sends Origin — so refusing any browser-originated upgrade costs nothing
    // and removes the attack class entirely.
    if request.headers().contains_key("origin") {
        return false;
    }
    let uri = request.uri();
    let Some(path_token) = uri.path().strip_prefix('/') else {
        return false;
    };
    constant_time_eq(path_token.as_bytes(), auth_token.as_bytes()) && uri.query().is_none()
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (left, right) in a.iter().zip(b) {
        difference |= left ^ right;
    }
    difference == 0
}

pub fn write_websocket_error_response<S: Write>(stream: &mut S, status: StatusCode) -> Result<()> {
    let response = Response::builder()
        .status(status)
        .header("Connection", "close")
        .body(())?;
    write_response(&mut *stream, &response)?;
    stream.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// An in-memory peer: reads come from `input`, writes collect in `output`.
    struct ScriptedPeer {
        input: Cursor<Vec<u8>>,
        output: Vec<u8>,
    }

    impl ScriptedPeer {
        fn sending(input: impl Into<Vec<u8>>) -> Self {
            Self {
                input: Cursor::new(input.into()),
                output: Vec::new(),
            }
        }
    }

    impl Read for ScriptedPeer {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.input.read(buffer)
        }
    }

    impl Write for ScriptedPeer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.output.write(bytes)
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    const UPGRADE: &str = "GET /secret HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n";

    #[test]
    fn websocket_request_path_requires_auth_token() {
        let allowed = Request::builder().uri("/secret").body(()).unwrap();
        let wrong_path = Request::builder().uri("/wrong").body(()).unwrap();
        let query = Request::builder().uri("/secret?x=1").body(()).unwrap();
        assert!(websocket_request_path_is_authorized(&allowed, "secret"));
        assert!(!websocket_request_path_is_authorized(&wrong_path, "secret"));
        assert!(!websocket_request_path_is_authorized(&query, "secret"));
    }

    #[test]
    fn websocket_upgrade_rejects_browser_origins() {
        // Electron's main process never sends Origin; anything that does is a
        // browser and has no business on this socket even with a valid token.
        let browser = Request::builder()
            .uri("/secret")
            .header("origin", "https://evil.example")
            .body(())
            .unwrap();
        let same_origin = Request::builder()
            .uri("/secret")
            .header("Origin", "http://127.0.0.1:1234")
            .body(())
            .unwrap();
        assert!(!websocket_request_path_is_authorized(&browser, "secret"));
        assert!(!websocket_request_path_is_authorized(
            &same_origin,
            "secret"
        ));
    }

    #[test]
    fn constant_time_eq_compares_bytes() {
        assert!(constant_time_eq(b"secret", b"secret"));
        assert!(!constant_time_eq(b"secret", b"secreT"));
        assert!(!constant_time_eq(b"secret", b"secre"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn upgrade_keeps_bytes_pipelined_after_the_request() {
        // The start of a masked text frame sent in the same packet.
        let frame_start = [0x81, 0x82, 0x01, 0x02, 0x03, 0x04];
        let mut input = UPGRADE.as_bytes().to_vec();
        input.extend_from_slice(&frame_start);
        let mut peer = ScriptedPeer::sending(input);
        let (request, tail) = read_websocket_upgrade(&mut peer).unwrap();
        assert_eq!(request.uri().path(), "/secret");
        assert_eq!(tail, frame_start);
        assert!(peer.output.is_empty());
    }

    #[test]
    fn upgrade_rejects_oversized_headers_with_413() {
        let padding = format!(
            "X-Padding: {}\r\n",
            "a".repeat(MAX_WEBSOCKET_HANDSHAKE_BYTES)
        );
        let mut peer = ScriptedPeer::sending(format!("GET /secret HTTP/1.1\r\n{padding}"));
        let error = read_websocket_upgrade(&mut peer).unwrap_err();
        assert!(error.to_string().contains("maximum header size"), "{error}");
        let response = String::from_utf8(peer.output).unwrap();
        assert!(response.starts_with("HTTP/1.1 413"), "{response}");
    }

    #[test]
    fn upgrade_reports_a_peer_that_leaves_mid_request() {
        let mut peer = ScriptedPeer::sending("GET /secret HTTP/1.1\r\nHost: 127.0.0.1\r\n");
        let error = read_websocket_upgrade(&mut peer).unwrap_err();
        assert!(error.to_string().contains("disconnected during handshake"));
    }

    #[test]
    fn error_responses_close_the_connection() {
        let mut output = Vec::new();
        write_websocket_error_response(&mut output, StatusCode::UNAUTHORIZED).unwrap();
        let response = String::from_utf8(output).unwrap().to_ascii_lowercase();
        assert!(
            response.starts_with("http/1.1 401 unauthorized\r\n"),
            "{response}"
        );
        assert!(response.contains("connection: close\r\n"), "{response}");
    }
}
