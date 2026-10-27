//! One authenticated WebSocket session: request reads, cancellation polling
//! between generated chunks, and the outgoing JSON and audio frames.

use std::collections::{HashSet, VecDeque};
use std::io::{Read, Write};
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
    float32_to_le_bytes, round_secs,
};

const WEBSOCKET_READ_TIMEOUT_SEC: u64 = 10;
const WEBSOCKET_IDLE_READ_TIMEOUT_SEC: u64 = 30 * 60;
const WEBSOCKET_WRITE_TIMEOUT_SEC: u64 = 30;
const MAX_WEBSOCKET_WRITE_BUFFER_BYTES: usize = 2 * 1024 * 1024;
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
        // Everything below relies on blocking reads and writes bounded by
        // timeouts. macOS and Windows hand an accepted socket the listener's
        // nonblocking mode, so never inherit it: an idle read loop would treat
        // every empty read as an expired timeout and answer it with a ping.
        stream
            .set_nonblocking(false)
            .context("Failed to make the WebSocket connection blocking")?;
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
    ///
    /// The socket is nonblocking only for the drain, so a poll costs a few
    /// syscalls instead of waiting out a read timeout before every chunk, and
    /// the idle read timeout set at accept time is never touched.
    pub fn poll_cancelled(&mut self, request_id: &str) -> Result<bool> {
        if self.peer_closed || self.cancelled_requests.contains(request_id) {
            return Ok(true);
        }
        self.socket
            .get_ref()
            .set_nonblocking(true)
            .context("Failed arming WebSocket cancel poll")?;
        let outcome = self.drain_buffered_requests();
        // Restore blocking mode even when draining failed, so a caller that
        // ignores the error does not inherit a nonblocking socket.
        let restored = self.socket.get_ref().set_nonblocking(false);
        outcome?;
        restored.context("Failed restoring blocking WebSocket reads")?;
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
                // tungstenite has already queued the pong. The next read here or
                // the next frame sent flushes it; answering explicitly on this
                // nonblocking socket would fail the poll whenever the client is
                // slow to read, where a queued pong just waits.
                Ok(
                    Message::Ping(_) | Message::Binary(_) | Message::Pong(_) | Message::Frame(_),
                ) => {}
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
        self.socket
            .send(Message::Text(serde_json::to_string(payload)?.into()))?;
        Ok(())
    }

    /// Send one audio chunk: its JSON metadata frame, then its samples as a
    /// binary frame of little-endian Float32. See [`write_audio_chunk`].
    pub fn send_audio_chunk(&mut self, metadata: &Value, samples: &[f32]) -> Result<()> {
        write_audio_chunk(&mut self.socket, metadata, samples)
    }

    pub fn close(&mut self) -> Result<()> {
        self.socket.close(None)?;
        Ok(())
    }
}

/// Queue a chunk's metadata and audio frames, then flush once. The frames are
/// exactly the ones two separate sends would produce, but sending each would
/// flush each: two writes, two TCP segments, and often two wakeups on the
/// client for every chunk. A chunk past tungstenite's write buffer target is
/// written as soon as it is queued, still behind its metadata and still in
/// one write.
fn write_audio_chunk<Stream: Read + Write>(
    socket: &mut WebSocket<Stream>,
    metadata: &Value,
    samples: &[f32],
) -> Result<()> {
    socket.write(Message::Text(serde_json::to_string(metadata)?.into()))?;
    socket.write(Message::Binary(float32_to_le_bytes(samples).into()))?;
    socket.flush()?;
    Ok(())
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
    if let Err(error) = socket2::SockRef::from(stream).set_keepalive(true) {
        eprintln!("Failed to enable SO_KEEPALIVE on WebSocket connection: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::MAX_AUDIO_CHUNK_SAMPLES;
    use crate::ws::test_support::{
        Client, READ_TIMEOUT, TOKEN, connect, connected_pair, decode_samples, read_binary,
        read_json, read_message, send_json,
    };
    use std::net::TcpListener;
    use std::thread;

    /// Asserts the bridge sent the client nothing it has not read yet.
    fn assert_nothing_sent(client: &mut Client) {
        client
            .get_ref()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        match client.read() {
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            other => panic!("expected no frames from the bridge, got {other:?}"),
        }
        client
            .get_ref()
            .set_read_timeout(Some(READ_TIMEOUT))
            .unwrap();
    }

    /// Sends `request` once the bridge has had time to start waiting for it.
    fn send_request_later(mut client: Client, request: &'static str) -> thread::JoinHandle<Client> {
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            client.send(Message::Text(request.into())).unwrap();
            client
        })
    }

    /// Writes binary frames to a client that is not reading until the kernel
    /// takes no more, leaving the rest of the last one in tungstenite's write
    /// buffer. A refused write is not enough on its own: the kernel keeps
    /// moving data into the client's receive buffer for a while after it, so
    /// the socket only counts as full once it still refuses after a pause.
    fn fill_send_buffer(connection: &mut WebSocketConnection) {
        const FRAME_BYTES: usize = 1024 * 1024;
        let would_block = |outcome: &tungstenite::Result<()>| {
            matches!(
                outcome,
                Err(tungstenite::Error::Io(error)) if error.kind() == std::io::ErrorKind::WouldBlock
            )
        };
        connection.socket.get_ref().set_nonblocking(true).unwrap();
        let mut full = false;
        for _ in 0..256 {
            // Queue a frame only once the previous one has been written out.
            let outcome = match connection.socket.flush() {
                Ok(()) => connection
                    .socket
                    .write(Message::Binary(vec![0; FRAME_BYTES].into())),
                pending => pending,
            };
            if would_block(&outcome) {
                thread::sleep(Duration::from_millis(50));
                if would_block(&connection.socket.flush()) {
                    full = true;
                    break;
                }
            } else {
                outcome.unwrap();
            }
        }
        connection.socket.get_ref().set_nonblocking(false).unwrap();
        assert!(full, "the client never pushed back");
    }

    #[test]
    fn a_connection_accepted_from_a_nonblocking_listener_still_waits_for_requests() {
        // macOS and Windows give an accepted socket the listener's nonblocking
        // mode. The bridge's idle read then failed at once, every time, and
        // each failure was answered with a ping: an idle bridge spun a core
        // and flooded its client.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let client = thread::spawn(move || connect(address, TOKEN).unwrap());
        let stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(1));
                }
                Err(error) => panic!("accept failed: {error}"),
            }
        };
        let mut connection = WebSocketConnection::accept(stream, TOKEN).unwrap();

        // The request only arrives after the bridge has started waiting, and
        // waiting sends the client nothing.
        let request = r#"{"requestId":"r1","payload":{}}"#;
        let sender = send_request_later(client.join().unwrap(), request);
        assert_eq!(connection.recv_text().unwrap().as_deref(), Some(request));
        assert_nothing_sent(&mut sender.join().unwrap());
    }

    #[test]
    fn idle_polls_return_without_waiting_out_a_timeout() {
        // A poll runs before every streamed chunk and progress frame. Each one
        // used to arm a 1 ms read timeout and, on an idle socket, wait it out,
        // so these polls took at least 200 ms; reading only what has arrived
        // takes a few microseconds each.
        const POLLS: u32 = 200;
        let (mut connection, _client) = connected_pair();
        let started = Instant::now();
        for _ in 0..POLLS {
            assert!(!connection.poll_cancelled("r1").unwrap());
        }
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_millis(100),
            "{POLLS} idle polls took {elapsed:?}"
        );
    }

    #[test]
    fn a_poll_leaves_the_connection_waiting_for_requests() {
        // The drain reads without blocking. Leaving the socket that way would
        // turn the next idle wait into a ping flood, and it must keep the idle
        // timeout it was given at accept time.
        let (mut connection, client) = connected_pair();
        assert!(!connection.poll_cancelled("r1").unwrap());
        assert_eq!(
            connection.socket.get_ref().read_timeout().unwrap(),
            Some(Duration::from_secs(WEBSOCKET_IDLE_READ_TIMEOUT_SEC))
        );
        let request = r#"{"requestId":"r2","payload":{}}"#;
        let sender = send_request_later(client, request);
        assert_eq!(connection.recv_text().unwrap().as_deref(), Some(request));
        assert_nothing_sent(&mut sender.join().unwrap());
    }

    #[test]
    fn a_poll_on_a_congested_socket_queues_its_pong_instead_of_failing() {
        // A client that is slow to read leaves the bridge's send buffer full.
        // The drain cannot write a pong without blocking then; failing the poll
        // would fail the generation, so the pong waits for the next send.
        let (mut connection, mut client) = connected_pair();
        fill_send_buffer(&mut connection);
        client
            .send(Message::Ping(b"congested".to_vec().into()))
            .unwrap();
        send_json(
            &mut client,
            json!({ "command": "cancel", "requestId": "r1" }),
        );
        assert!(wait_for_cancel(&mut connection, "r1"));

        // Once the client reads again, the next send delivers the queued pong
        // ahead of its own frame.
        let reader = thread::spawn(move || {
            loop {
                match read_message(&mut client) {
                    Message::Binary(_) => {}
                    first => return (first, read_message(&mut client)),
                }
            }
        });
        connection
            .send_json(&json!({ "type": "progress" }))
            .unwrap();
        let (first, second) = reader.join().unwrap();
        assert_eq!(first, Message::Pong(b"congested".to_vec().into()));
        assert_eq!(second, Message::Text(r#"{"type":"progress"}"#.into()));
    }

    #[test]
    fn a_frame_split_across_polls_completes_on_a_later_poll() {
        // A nonblocking read can stop partway through a frame. The bytes read
        // so far must wait in tungstenite's buffer for the rest of it.
        let (mut connection, mut client) = connected_pair();
        let frame = masked_text_frame(r#"{"command":"cancel","requestId":"r1"}"#);
        let (head, tail) = frame.split_at(frame.len() / 2);
        client.get_mut().write_all(head).unwrap();
        thread::sleep(Duration::from_millis(20));
        assert!(!connection.poll_cancelled("r1").unwrap());
        client.get_mut().write_all(tail).unwrap();
        assert!(wait_for_cancel(&mut connection, "r1"));
    }

    /// Polls until `request_id` reads as cancelled, or gives up at the deadline.
    fn wait_for_cancel(connection: &mut WebSocketConnection, request_id: &str) -> bool {
        let deadline = Instant::now() + READ_TIMEOUT;
        while Instant::now() < deadline {
            if connection.poll_cancelled(request_id).unwrap() {
                return true;
            }
            thread::sleep(Duration::from_millis(1));
        }
        false
    }

    fn upgrade_request(path: &str, extra_headers: &str) -> String {
        format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n{extra_headers}\r\n"
        )
    }

    fn masked_text_frame(text: &str) -> Vec<u8> {
        let mask = [0x37, 0xfa, 0x21, 0x3d];
        let payload = text.as_bytes();
        let length = u8::try_from(payload.len()).unwrap();
        assert!(length < 126, "short frames only");
        let mut frame = vec![0x81, 0x80 | length];
        frame.extend_from_slice(&mask);
        frame.extend(
            payload
                .iter()
                .enumerate()
                .map(|(index, byte)| byte ^ mask[index % 4]),
        );
        frame
    }

    #[test]
    fn polling_finds_a_buffered_cancel_for_its_own_request() {
        let (mut connection, mut client) = connected_pair();
        assert!(!connection.poll_cancelled("r1").unwrap());
        send_json(
            &mut client,
            json!({ "command": "cancel", "requestId": "r1" }),
        );
        assert!(wait_for_cancel(&mut connection, "r1"));
        assert!(!connection.poll_cancelled("r2").unwrap());
        // A finished request releases its cancel, so a reused id starts clean.
        connection.finish_request("r1");
        assert!(!connection.poll_cancelled("r1").unwrap());
        assert!(connection.bail_if_cancelled("r1").is_ok());
    }

    #[test]
    fn cancelled_requests_bail_with_the_message_the_client_matches() {
        let (mut connection, mut client) = connected_pair();
        send_json(
            &mut client,
            json!({ "command": "cancel", "requestId": "r1" }),
        );
        assert!(wait_for_cancel(&mut connection, "r1"));
        let error = connection.bail_if_cancelled("r1").unwrap_err();
        assert_eq!(error.to_string(), CANCELLED_MESSAGE);
    }

    #[test]
    fn a_cancel_that_arrived_with_its_request_is_seen_by_the_first_poll() {
        // Both frames reach the socket in one write, so one read takes them
        // both and the cancel waits in tungstenite's buffer rather than the
        // kernel's. A poll that only asked whether the socket is readable
        // would miss it.
        let (mut connection, mut client) = connected_pair();
        let request = json!({ "requestId": "r1", "payload": {} }).to_string();
        let cancel = json!({ "command": "cancel", "requestId": "r1" }).to_string();
        client.write(Message::Text(request.clone().into())).unwrap();
        client.write(Message::Text(cancel.into())).unwrap();
        client.flush().unwrap();
        assert_eq!(connection.recv_text().unwrap(), Some(request));
        assert!(connection.poll_cancelled("r1").unwrap());
    }

    #[test]
    fn requests_read_mid_generation_are_replayed_in_order() {
        let (mut connection, mut client) = connected_pair();
        for index in 0..MAX_PENDING_REQUESTS + 2 {
            send_json(
                &mut client,
                json!({ "requestId": format!("queued-{index}"), "payload": {} }),
            );
        }
        // The marker is sent last, so once it is seen everything before it
        // has been drained.
        send_json(
            &mut client,
            json!({ "command": "cancel", "requestId": "marker" }),
        );
        assert!(wait_for_cancel(&mut connection, "marker"));
        for index in 0..MAX_PENDING_REQUESTS {
            let replayed = connection.recv_text().unwrap().unwrap();
            assert!(
                replayed.contains(&format!("\"queued-{index}\"")),
                "{replayed}"
            );
        }
        // The overflow was dropped: the next request comes from the wire.
        send_json(&mut client, json!({ "requestId": "fresh", "payload": {} }));
        let next = connection.recv_text().unwrap().unwrap();
        assert!(next.contains("\"fresh\""), "{next}");
    }

    #[test]
    fn tracked_cancellations_are_bounded() {
        let (mut connection, mut client) = connected_pair();
        for index in 0..MAX_TRACKED_CANCELLATIONS {
            send_json(
                &mut client,
                json!({ "command": "cancel", "requestId": format!("old-{index}") }),
            );
        }
        let newest = format!("old-{}", MAX_TRACKED_CANCELLATIONS - 1);
        assert!(wait_for_cancel(&mut connection, &newest));
        assert!(connection.poll_cancelled("old-0").unwrap());
        // One cancel past the cap forgets the older ones instead of growing.
        send_json(
            &mut client,
            json!({ "command": "cancel", "requestId": "new" }),
        );
        assert!(wait_for_cancel(&mut connection, "new"));
        assert!(!connection.poll_cancelled("old-0").unwrap());
    }

    #[test]
    fn cancels_without_a_request_id_are_ignored() {
        let (mut connection, mut client) = connected_pair();
        send_json(&mut client, json!({ "command": "cancel" }));
        send_json(
            &mut client,
            json!({ "command": "cancel", "requestId": " " }),
        );
        send_json(
            &mut client,
            json!({ "command": "cancel", "requestId": "marker" }),
        );
        assert!(wait_for_cancel(&mut connection, "marker"));
        assert!(!connection.poll_cancelled(" ").unwrap());
        // Nor were they deferred as requests.
        send_json(&mut client, json!({ "requestId": "next", "payload": {} }));
        let next = connection.recv_text().unwrap().unwrap();
        assert!(next.contains("\"next\""), "{next}");
    }

    #[test]
    fn a_peer_close_cancels_whatever_is_running() {
        let (mut connection, mut client) = connected_pair();
        client.close(None).unwrap();
        assert!(wait_for_cancel(&mut connection, "any-request"));
        assert_eq!(connection.recv_text().unwrap(), None);
    }

    #[test]
    fn pings_read_while_polling_are_answered() {
        let (mut connection, mut client) = connected_pair();
        client
            .send(Message::Ping(b"keepalive".to_vec().into()))
            .unwrap();
        send_json(
            &mut client,
            json!({ "command": "cancel", "requestId": "marker" }),
        );
        assert!(wait_for_cancel(&mut connection, "marker"));
        assert_eq!(
            read_message(&mut client),
            Message::Pong(b"keepalive".to_vec().into())
        );
    }

    #[test]
    fn binary_requests_are_refused() {
        let (mut connection, mut client) = connected_pair();
        client.send(Message::Binary(vec![1, 2, 3].into())).unwrap();
        let error = connection.recv_text().unwrap_err();
        assert_eq!(
            error.to_string(),
            "Binary WebSocket requests are not supported."
        );
    }

    #[test]
    fn a_request_pipelined_with_the_upgrade_is_served() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut peer = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let request = r#"{"requestId":"pipelined","payload":{}}"#;
        let mut packet = upgrade_request(&format!("/{TOKEN}"), "").into_bytes();
        packet.extend(masked_text_frame(request));
        peer.write_all(&packet).unwrap();

        let (stream, _) = listener.accept().unwrap();
        let mut connection = WebSocketConnection::accept(stream, TOKEN).unwrap();
        assert_eq!(connection.recv_text().unwrap().as_deref(), Some(request));
    }

    #[test]
    fn upgrades_without_the_token_or_from_a_browser_get_401() {
        for (path, extra_headers) in [
            ("/wrong-token".to_string(), ""),
            (format!("/{TOKEN}?debug=1"), ""),
            (format!("/{TOKEN}"), "Origin: https://evil.example\r\n"),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let mut peer = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
            peer.set_read_timeout(Some(READ_TIMEOUT)).unwrap();
            peer.write_all(upgrade_request(&path, extra_headers).as_bytes())
                .unwrap();

            let (stream, _) = listener.accept().unwrap();
            let error = WebSocketConnection::accept(stream, TOKEN)
                .err()
                .expect("the upgrade must be refused");
            assert_eq!(error.to_string(), "Unauthorized WebSocket path.");
            let mut response = String::new();
            peer.read_to_string(&mut response).unwrap();
            assert!(
                response.starts_with("HTTP/1.1 401 Unauthorized"),
                "{path}: {response}"
            );
        }
    }

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

    /// A stream that records every write and flush the socket makes.
    #[derive(Default)]
    struct RecordingStream {
        writes: Vec<Vec<u8>>,
        flushes: usize,
    }

    impl Read for RecordingStream {
        fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::WouldBlock.into())
        }
    }

    impl Write for RecordingStream {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.writes.push(buf.to_vec());
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            self.flushes += 1;
            Ok(())
        }
    }

    fn recording_socket() -> WebSocket<RecordingStream> {
        WebSocket::from_raw_socket(RecordingStream::default(), Role::Server, None)
    }

    /// The bytes the bridge sent for a chunk before metadata and audio shared a
    /// flush: a text send, then a binary send of the scrubbed samples.
    fn two_send_bytes(metadata: &Value, samples: &[f32]) -> Vec<u8> {
        let encoded = samples
            .iter()
            .flat_map(|sample| {
                let clean = if sample.is_finite() { *sample } else { 0.0 };
                clean.to_le_bytes()
            })
            .collect::<Vec<u8>>();
        let mut socket = recording_socket();
        socket
            .send(Message::Text(metadata.to_string().into()))
            .unwrap();
        socket.send(Message::Binary(encoded.into())).unwrap();
        let stream = socket.get_ref();
        assert_eq!((stream.writes.len(), stream.flushes), (2, 2));
        stream.writes.concat()
    }

    #[test]
    fn an_audio_chunk_is_one_write_and_one_flush_with_unchanged_bytes() {
        let metadata = json!({
            "type": "audio_chunk",
            "requestId": "r1",
            "index": 0,
            "total": 0,
            "sampleRate": 24_000,
            "sampleCount": 4,
            "silenceAfterSamples": 0,
        });
        // A small chunk stays in tungstenite's buffer until the flush, and the
        // largest one is written as soon as it is queued, so both paths count.
        let small = vec![0.25, f32::NAN, -0.5, f32::INFINITY];
        let mut largest = vec![0.125; MAX_AUDIO_CHUNK_SAMPLES];
        largest[1] = f32::NEG_INFINITY;
        for samples in [small, largest] {
            let mut socket = recording_socket();
            write_audio_chunk(&mut socket, &metadata, &samples).unwrap();
            let stream = socket.get_ref();
            assert_eq!(
                stream.writes.len(),
                1,
                "writes for {} samples",
                samples.len()
            );
            assert_eq!(stream.flushes, 1, "flushes for {} samples", samples.len());
            assert!(
                stream.writes[0] == two_send_bytes(&metadata, &samples),
                "wire bytes changed for {} samples",
                samples.len()
            );
        }
    }

    #[test]
    fn a_client_reads_an_audio_chunk_as_metadata_then_scrubbed_samples() {
        let (mut connection, mut client) = connected_pair();
        let metadata = json!({ "type": "audio_chunk", "requestId": "r1", "sampleCount": 3 });
        connection
            .send_audio_chunk(&metadata, &[0.5, f32::NAN, -1.0])
            .unwrap();
        assert_eq!(read_json(&mut client), metadata);
        assert_eq!(decode_samples(&read_binary(&mut client)), [0.5, 0.0, -1.0]);
    }

    #[test]
    fn qwen_transport_chunks_fit_the_websocket_write_buffer() {
        assert!(
            MAX_AUDIO_CHUNK_SAMPLES * std::mem::size_of::<f32>() < MAX_WEBSOCKET_WRITE_BUFFER_BYTES
        );
    }
}
