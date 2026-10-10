//! One authenticated WebSocket session: request reads, cancellation polling
//! between generated chunks, and the outgoing JSON and audio frames.

use std::collections::{HashSet, VecDeque};
use std::io::Write;
use std::net::TcpStream;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use tungstenite::handshake::server::{create_response, write_response};
use tungstenite::http::StatusCode;
use tungstenite::protocol::{Role, WebSocketConfig};
use tungstenite::{Message, WebSocket};

use super::handshake::{
    read_websocket_upgrade, websocket_request_path_is_authorized, write_websocket_error_response,
};
use crate::protocol::{
    BufferedRequest, CANCELLED_MESSAGE, MAX_WEBSOCKET_TEXT_FRAME_BYTES, classify_buffered_request,
    round_secs,
};

const WEBSOCKET_READ_TIMEOUT_SEC: u64 = 10;
const WEBSOCKET_IDLE_READ_TIMEOUT_SEC: u64 = 30 * 60;
const WEBSOCKET_WRITE_TIMEOUT_SEC: u64 = 30;
const MAX_WEBSOCKET_WRITE_BUFFER_BYTES: usize = 2 * 1024 * 1024;
// Poll budget for draining cancel frames between generation chunks. Short
// enough to add no measurable latency per chunk, long enough for a frame that
// is already in the socket buffer to be read in one pass.
const CANCEL_POLL_TIMEOUT: Duration = Duration::from_millis(1);
// Bound the request/cancel bookkeeping a peer can accumulate between requests.
const MAX_PENDING_REQUESTS: usize = 8;
const MAX_TRACKED_CANCELLATIONS: usize = 64;

pub struct WebSocketConnection {
    socket: WebSocket<TcpStream>,
    /// Non-cancel requests read while draining the socket mid-generation.
    /// `recv_text` serves these before touching the wire so an out-of-turn
    /// request is deferred rather than dropped.
    pending_requests: VecDeque<String>,
    cancelled_requests: HashSet<String>,
    peer_closed: bool,
}

impl WebSocketConnection {
    pub fn accept(mut stream: TcpStream, auth_token: &str) -> Result<Self> {
        stream
            .set_read_timeout(Some(Duration::from_secs(WEBSOCKET_READ_TIMEOUT_SEC)))
            .context("Failed to set WebSocket read timeout")?;
        enable_tcp_keepalive(&stream);
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_WEBSOCKET_TEXT_FRAME_BYTES))
            .max_frame_size(Some(MAX_WEBSOCKET_TEXT_FRAME_BYTES))
            .max_write_buffer_size(MAX_WEBSOCKET_WRITE_BUFFER_BYTES)
            .accept_unmasked_frames(false);
        let (request, tail) = read_websocket_upgrade(&mut stream)?;
        if !websocket_request_path_is_authorized(&request, auth_token) {
            let _ = write_websocket_error_response(&mut stream, StatusCode::UNAUTHORIZED);
            bail!("Unauthorized WebSocket path.");
        }
        let response = create_response(&request).context("Invalid WebSocket upgrade request")?;
        write_response(&mut stream, &response)
            .context("Failed writing WebSocket upgrade response")?;
        stream
            .flush()
            .context("Failed flushing WebSocket upgrade response")?;
        stream
            .set_read_timeout(Some(Duration::from_secs(WEBSOCKET_IDLE_READ_TIMEOUT_SEC)))
            .context("Failed to set WebSocket idle read timeout")?;
        stream
            .set_write_timeout(Some(Duration::from_secs(WEBSOCKET_WRITE_TIMEOUT_SEC)))
            .context("Failed to set WebSocket write timeout")?;
        let socket = WebSocket::from_partially_read(stream, tail, Role::Server, Some(config));
        Ok(Self {
            socket,
            pending_requests: VecDeque::new(),
            cancelled_requests: HashSet::new(),
            peer_closed: false,
        })
    }

    pub fn recv_text(&mut self) -> Result<Option<String>> {
        if let Some(deferred) = self.pending_requests.pop_front() {
            return Ok(Some(deferred));
        }
        if self.peer_closed {
            return Ok(None);
        }
        loop {
            match self.socket.read() {
                Ok(Message::Text(text)) => return Ok(Some(text.to_string())),
                Ok(Message::Binary(_)) => bail!("Binary WebSocket requests are not supported."),
                Ok(Message::Close(_)) => {
                    self.peer_closed = true;
                    return Ok(None);
                }
                Ok(Message::Ping(payload)) => self.socket.send(Message::Pong(payload))?,
                Ok(Message::Pong(_) | Message::Frame(_)) => {}
                Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                    self.peer_closed = true;
                    return Ok(None);
                }
                Err(tungstenite::Error::Io(err))
                    if matches!(
                        err.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    self.socket
                        .send(Message::Ping(Vec::new().into()))
                        .context("Failed pinging idle WebSocket peer")?;
                }
                Err(err) => return Err(err).context("Failed reading WebSocket request"),
            }
        }
    }

    /// Abort a request the client has cancelled. Generation unwinds through the
    /// normal error path so the process — and whatever model it has loaded —
    /// stays alive for the next request instead of being killed from outside.
    pub fn bail_if_cancelled(&mut self, request_id: &str) -> Result<()> {
        if self.poll_cancelled(request_id)? {
            bail!("{CANCELLED_MESSAGE}");
        }
        Ok(())
    }

    /// Drain whatever is already buffered on the socket and report whether
    /// `request_id` has been cancelled. Called between generation chunks so a
    /// Stop unwinds the request through the normal error path, leaving the
    /// process (and its loaded model) alive for the next generation.
    pub fn poll_cancelled(&mut self, request_id: &str) -> Result<bool> {
        if self.peer_closed || self.cancelled_requests.contains(request_id) {
            return Ok(true);
        }
        self.socket
            .get_ref()
            .set_read_timeout(Some(CANCEL_POLL_TIMEOUT))
            .context("Failed arming WebSocket cancel poll")?;
        let outcome = self.drain_buffered_requests();
        // Restore the idle deadline even when draining failed, so a caller that
        // ignores the error does not inherit the 1ms poll timeout.
        let restored = self
            .socket
            .get_ref()
            .set_read_timeout(Some(Duration::from_secs(WEBSOCKET_IDLE_READ_TIMEOUT_SEC)));
        outcome?;
        restored.context("Failed restoring WebSocket idle read timeout")?;
        Ok(self.peer_closed || self.cancelled_requests.contains(request_id))
    }

    fn drain_buffered_requests(&mut self) -> Result<()> {
        loop {
            match self.socket.read() {
                Ok(Message::Text(text)) => self.record_buffered_request(text.to_string()),
                Ok(Message::Close(_)) => {
                    self.peer_closed = true;
                    return Ok(());
                }
                Ok(Message::Ping(payload)) => self.socket.send(Message::Pong(payload))?,
                Ok(Message::Binary(_) | Message::Pong(_) | Message::Frame(_)) => {}
                Err(tungstenite::Error::Io(err))
                    if matches!(
                        err.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    return Ok(());
                }
                Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                    self.peer_closed = true;
                    return Ok(());
                }
                Err(err) => return Err(err).context("Failed reading WebSocket cancel poll"),
            }
        }
    }

    fn record_buffered_request(&mut self, text: String) {
        match classify_buffered_request(text) {
            BufferedRequest::Cancel(request_id) => {
                if self.cancelled_requests.len() >= MAX_TRACKED_CANCELLATIONS {
                    self.cancelled_requests.clear();
                }
                self.cancelled_requests.insert(request_id);
            }
            // Not a cancel: defer it so the request loop still sees it. Dropping
            // the overflow is deliberate — the client never pipelines requests.
            BufferedRequest::Deferred(text) => {
                if self.pending_requests.len() < MAX_PENDING_REQUESTS {
                    self.pending_requests.push_back(text);
                }
            }
            BufferedRequest::Ignored => {}
        }
    }

    /// Release the cancellation bookkeeping for a request that has finished, so
    /// a later request can never inherit a stale cancel.
    pub fn finish_request(&mut self, request_id: &str) {
        self.cancelled_requests.remove(request_id);
    }

    pub fn send_progress(
        &mut self,
        request_id: &str,
        phase: &str,
        message: impl Into<String>,
        started: Instant,
    ) -> Result<()> {
        self.send_json(&json!({
            "type": "progress",
            "requestId": request_id,
            "phase": phase,
            "message": message.into(),
            "elapsedSec": round_secs(started.elapsed().as_secs_f64()),
        }))
    }

    pub fn send_json(&mut self, payload: &Value) -> Result<()> {
        let body = serde_json::to_vec(payload)?;
        let text = String::from_utf8(body).context("WebSocket JSON payload was not UTF-8")?;
        self.socket.send(Message::Text(text.into()))?;
        Ok(())
    }

    pub fn send_binary(&mut self, payload: Vec<u8>) -> Result<()> {
        self.socket.send(Message::Binary(payload.into()))?;
        Ok(())
    }

    pub fn close(&mut self) -> Result<()> {
        self.socket.close(None)?;
        Ok(())
    }
}

pub fn is_client_disconnect(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| {
        cause
            .downcast_ref::<tungstenite::Error>()
            .is_some_and(|error| match error {
                tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => true,
                // Only the kinds that actually mean "the peer went away" count.
                // Treating every I/O error as a disconnect made a stalled write
                // (WEBSOCKET_WRITE_TIMEOUT_SEC) exit 0 with no result frame, so
                // the client reported a generic close and the cause was lost.
                tungstenite::Error::Io(io) => matches!(
                    io.kind(),
                    std::io::ErrorKind::BrokenPipe
                        | std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::ConnectionAborted
                        | std::io::ErrorKind::NotConnected
                        | std::io::ErrorKind::UnexpectedEof
                ),
                _ => false,
            })
    })
}

fn enable_tcp_keepalive(stream: &TcpStream) {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let enabled: libc::c_int = 1;
        let result = unsafe {
            libc::setsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_KEEPALIVE,
                std::ptr::from_ref(&enabled).cast(),
                std::mem::size_of::<libc::c_int>() as libc::socklen_t,
            )
        };
        if result != 0 {
            eprintln!(
                "Failed to enable SO_KEEPALIVE on WebSocket connection: {}",
                std::io::Error::last_os_error()
            );
        }
    }
    #[cfg(not(unix))]
    let _ = stream;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::MAX_AUDIO_CHUNK_SAMPLES;

    #[test]
    fn client_disconnect_covers_peer_loss_but_not_stalled_writes() {
        use std::io::{Error as IoError, ErrorKind};

        let disconnects = [
            tungstenite::Error::ConnectionClosed,
            tungstenite::Error::AlreadyClosed,
            tungstenite::Error::Io(IoError::from(ErrorKind::BrokenPipe)),
            tungstenite::Error::Io(IoError::from(ErrorKind::ConnectionReset)),
            tungstenite::Error::Io(IoError::from(ErrorKind::UnexpectedEof)),
        ];
        for error in disconnects {
            assert!(is_client_disconnect(&anyhow::Error::from(error)));
        }

        // A write that hit WEBSOCKET_WRITE_TIMEOUT_SEC is a stalled peer, not a
        // departed one: reporting it as a clean disconnect exits 0 and loses the
        // cause. Same for any other unrelated I/O failure.
        let stalls = [
            tungstenite::Error::Io(IoError::from(ErrorKind::WouldBlock)),
            tungstenite::Error::Io(IoError::from(ErrorKind::TimedOut)),
            tungstenite::Error::Io(IoError::from(ErrorKind::PermissionDenied)),
        ];
        for error in stalls {
            assert!(!is_client_disconnect(&anyhow::Error::from(error)));
        }
    }

    #[test]
    fn qwen_transport_chunks_fit_the_websocket_write_buffer() {
        assert!(
            MAX_AUDIO_CHUNK_SAMPLES * std::mem::size_of::<f32>() < MAX_WEBSOCKET_WRITE_BUFFER_BYTES
        );
    }
}
