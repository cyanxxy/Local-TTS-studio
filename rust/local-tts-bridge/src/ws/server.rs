//! The loopback listener, the single owning connection, and the request loop
//! that drives a model backend.

use std::io::Write;
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

use super::connection::{WebSocketConnection, is_client_disconnect};
use crate::protocol::{
    GenerationOutput, MAX_AUDIO_CHUNK_SAMPLES, WebSocketRequest, is_elapsed_phase_timing,
    round_secs, validate_generation_output,
};

// Handshakes run on their own threads so one slow or silent peer cannot stall
// the accept loop past the client's connect budget. Cap the concurrent
// handshakes so that indirection is not itself an unbounded-thread vector.
const MAX_CONCURRENT_HANDSHAKES: usize = 8;
// A loopback connect completes or is refused at once; the bound only matters
// if the listener's backlog is full.
const ACCEPTOR_WAKE_TIMEOUT: Duration = Duration::from_secs(1);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);

/// A model runtime the request loop can drive.
pub trait Backend {
    /// Load weights ahead of the first generation and describe what is now
    /// resident.
    fn warm(&mut self, payload: Value) -> Result<Value>;

    /// Run one generation. Streaming backends send audio through `connection`
    /// as it is produced. Every backend polls `connection` for a cancel at
    /// each checkpoint it has and then fails with `CANCELLED_MESSAGE`.
    fn generate(
        &mut self,
        request_id: &str,
        payload: Value,
        connection: &mut WebSocketConnection,
    ) -> Result<GenerationOutput>;
}

/// Bind the listener, refusing anything that is not loopback both before and
/// after binding.
pub fn bind_loopback_listener(host: &str, port: u16) -> Result<(TcpListener, SocketAddr)> {
    let bind_addresses = resolve_loopback_bind_addresses(host, port)?;
    let listener = TcpListener::bind(bind_addresses.as_slice())
        .with_context(|| format!("Failed to bind WebSocket bridge on {host}:{port}"))?;
    let local_address = listener
        .local_addr()
        .context("Failed reading WebSocket bridge listener address")?;
    ensure!(
        local_address.ip().is_loopback(),
        "WebSocket bridge must bind to a loopback address."
    );
    Ok((listener, local_address))
}

fn resolve_loopback_bind_addresses(host: &str, port: u16) -> Result<Vec<SocketAddr>> {
    let addresses = (host, port)
        .to_socket_addrs()
        .with_context(|| format!("Failed to resolve WebSocket bridge host '{host}'"))?
        .collect::<Vec<_>>();
    ensure!(
        !addresses.is_empty(),
        "WebSocket bridge host '{host}' resolved to no addresses."
    );
    ensure!(
        addresses.iter().all(|address| address.ip().is_loopback()),
        "WebSocket bridge host must resolve only to loopback addresses."
    );
    Ok(addresses)
}

/// Accept the one authenticated connection that owns this process and serve
/// it until it disconnects or asks to shut down.
pub fn serve_owner(
    listener: TcpListener,
    auth_token: &str,
    backend: &mut dyn Backend,
) -> Result<()> {
    // There is exactly one process owner. The bounded channel is a backstop;
    // the acceptor's atomic claim is what prevents every later completed
    // handshake from retaining a socket after the receiver has taken that owner.
    let (connections, incoming) = mpsc::sync_channel::<WebSocketConnection>(1);
    spawn_acceptor(listener, auth_token.to_owned(), connections)?;
    let mut websocket = incoming
        .recv()
        .context("Failed accepting WebSocket client")?;
    match serve_websocket_connection(&mut websocket, backend) {
        Ok(_) => {}
        Err(err) if is_client_disconnect(&err) => {
            eprintln!("WebSocket bridge client disconnected: {err:#}");
        }
        Err(err) => return Err(err),
    }
    let _ = websocket.close();
    // One authenticated connection owns this process. Electron never reconnects
    // to an existing child, so exit when that owner disconnects instead of
    // leaving an unreachable loopback listener orphaned.
    Ok(())
}

/// Accept connections until one completes an authorized handshake, then close
/// the listener. The acceptor blocks in `accept`, so a connection is picked up
/// the moment it arrives. Each handshake (header read, token check, upgrade
/// write) runs on its own thread: a peer that connects and then goes silent
/// would otherwise hold the acceptor for the whole handshake deadline and lock
/// the legitimate client out for longer than its connect budget.
fn spawn_acceptor(
    listener: TcpListener,
    auth_token: String,
    connections: SyncSender<WebSocketConnection>,
) -> Result<JoinHandle<()>> {
    let listener_address = listener
        .local_addr()
        .context("Failed reading WebSocket bridge listener address")?;
    let in_flight = Arc::new(AtomicUsize::new(0));
    let owner_delivered = Arc::new(AtomicBool::new(false));
    thread::Builder::new()
        .name("ws-acceptor".to_string())
        .spawn(move || {
            loop {
                if owner_delivered.load(Ordering::Acquire) {
                    return;
                }
                // Dropping the sender on a listener failure surfaces as a recv
                // error in serve_owner, matching the previous fatal-accept-error
                // behaviour instead of spinning on a socket that will never
                // accept again.
                let Ok((stream, _)) = listener.accept() else {
                    return;
                };
                // Once the owner is claimed, the next connection, whether a
                // stray peer or the claiming handshake's wake-up, ends the
                // acceptor without a handshake, and dropping the listener
                // refuses every connection after it.
                if owner_delivered.load(Ordering::Acquire) {
                    return;
                }
                let _ = stream.set_nodelay(true);
                if in_flight.fetch_add(1, Ordering::SeqCst) >= MAX_CONCURRENT_HANDSHAKES {
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                    eprintln!(
                        "WebSocket bridge refused a connection: too many pending handshakes."
                    );
                    continue;
                }
                let auth_token = auth_token.clone();
                let connections = connections.clone();
                let handshake_in_flight = Arc::clone(&in_flight);
                let handshake_owner_delivered = Arc::clone(&owner_delivered);
                if thread::Builder::new()
                    .name("ws-handshake".to_string())
                    .spawn(move || {
                        match WebSocketConnection::accept(stream, &auth_token) {
                            Ok(connection) => {
                                if claim_websocket_owner(&handshake_owner_delivered) {
                                    // The receiver is waiting for this sole
                                    // owner. If it disappeared unexpectedly,
                                    // dropping the connection here still
                                    // closes the stream.
                                    let _ = connections.send(connection);
                                    wake_acceptor(listener_address);
                                }
                                // A successful orphan is dropped immediately.
                            }
                            Err(err) => eprintln!("WebSocket bridge rejected connection: {err}"),
                        }
                        handshake_in_flight.fetch_sub(1, Ordering::SeqCst);
                    })
                    .is_err()
                {
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                }
            }
        })
        .context("Failed starting the WebSocket acceptor")
}

fn claim_websocket_owner(owner_delivered: &AtomicBool) -> bool {
    owner_delivered
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}

/// The acceptor is usually blocked in `accept` when the owner is claimed. One
/// more connection lets it see the claim and close the listener, instead of
/// leaving the port open until some other peer happens to connect. If the
/// acceptor has already stopped, the connection is refused, which is fine.
fn wake_acceptor(listener_address: SocketAddr) {
    let _ = TcpStream::connect_timeout(&listener_address, ACCEPTOR_WAKE_TIMEOUT);
}

fn serve_websocket_connection(
    websocket: &mut WebSocketConnection,
    backend: &mut dyn Backend,
) -> Result<bool> {
    loop {
        let raw_message = match websocket.recv_text() {
            Ok(Some(message)) => message,
            Ok(None) => return Ok(false),
            Err(err) if is_client_disconnect(&err) => return Ok(false),
            Err(err) => return Err(err).context("Failed reading WebSocket request"),
        };
        let request: WebSocketRequest = match serde_json::from_str(&raw_message) {
            Ok(value) => value,
            Err(err) => {
                eprintln!("WebSocket bridge rejected invalid request JSON: {err}");
                send_request_error(
                    websocket,
                    "",
                    &anyhow::anyhow!("Invalid WebSocket request JSON."),
                )?;
                continue;
            }
        };
        if request.command.as_deref() == Some("shutdown") {
            return Ok(true);
        }
        if request.command.as_deref() == Some("cancel") {
            // A cancel that lands between generations has nothing to abort; the
            // mid-generation poll consumes the ones that matter. Acknowledging
            // it here would look like a result frame to the client.
            continue;
        }

        let request_id = request.request_id.unwrap_or_default();
        if request_id.trim().is_empty() {
            send_request_error(
                websocket,
                &request_id,
                &anyhow::anyhow!("WebSocket requests require a non-empty requestId."),
            )?;
            continue;
        }
        let payload = request.payload.unwrap_or(Value::Null);
        if request.command.as_deref() == Some("warm") {
            let outcome = {
                let _heartbeat = Heartbeat::start();
                backend.warm(payload)
            };
            send_request_outcome(websocket, &request_id, outcome)?;
            continue;
        }
        if request.command.is_some() {
            send_request_error(
                websocket,
                &request_id,
                &anyhow::anyhow!("Unsupported WebSocket command."),
            )?;
            continue;
        }

        let outcome = {
            let _heartbeat = Heartbeat::start();
            backend.generate(&request_id, payload, websocket)
        };
        websocket.finish_request(&request_id);
        match outcome {
            Ok(output) => send_generation_result(websocket, &request_id, output)?,
            Err(err) => {
                if is_client_disconnect(&err) {
                    return Ok(false);
                }
                send_request_error(websocket, &request_id, &err)?;
            }
        }
    }
}

fn send_request_outcome(
    websocket: &mut WebSocketConnection,
    request_id: &str,
    outcome: Result<Value>,
) -> Result<()> {
    match outcome {
        Ok(result) => websocket.send_json(&json!({
            "type": "result",
            "requestId": request_id,
            "ok": true,
            "result": result,
        })),
        Err(err) => send_request_error(websocket, request_id, &err),
    }
}

fn send_request_error(
    websocket: &mut WebSocketConnection,
    request_id: &str,
    error: &anyhow::Error,
) -> Result<()> {
    websocket.send_json(&json!({
        "type": "result",
        "requestId": request_id,
        "ok": false,
        "error": error.to_string(),
        "details": format!("{error:#}"),
    }))
}

fn send_generation_result(
    websocket: &mut WebSocketConnection,
    request_id: &str,
    mut output: GenerationOutput,
) -> Result<()> {
    if let Err(err) = validate_generation_output(&output) {
        return send_request_error(websocket, request_id, &err);
    }

    let (sample_count, chunk_count) = output.audio_totals();
    if output.streamed_audio.is_none() {
        let transport_started = Instant::now();
        for (index, chunk) in output.samples.chunks(MAX_AUDIO_CHUNK_SAMPLES).enumerate() {
            let metadata = json!({
                "type": "audio_chunk",
                "requestId": request_id,
                "index": index,
                "total": chunk_count,
                "sampleRate": output.sample_rate,
                "sampleCount": chunk.len(),
                "silenceAfterSamples": 0,
            });
            websocket.send_audio_chunk(&metadata, chunk)?;
        }
        output.phase_timings.insert(
            "transportEncodingSec".to_string(),
            json!(round_secs(transport_started.elapsed().as_secs_f64())),
        );
    }

    let duration_sec = sample_count as f64 / output.sample_rate as f64;
    let elapsed_sec = output
        .phase_timings
        .iter()
        .filter(|(key, _)| is_elapsed_phase_timing(key))
        .filter_map(|(_, value)| Value::as_f64(value))
        .sum::<f64>();
    let mut result = json!({
        "sampleRate": output.sample_rate,
        "modelRepo": output.model_repo,
        "durationSec": round_secs(duration_sec),
        "elapsedSec": round_secs(elapsed_sec),
        "audioTransport": "websocket-binary",
        "audioChunkCount": chunk_count,
        "phaseTimingsSec": output.phase_timings,
    });
    if let Some(device) = output.device {
        result["device"] = json!(device);
    }
    if !output.warnings.is_empty() {
        result["warnings"] = json!(output.warnings);
    }
    websocket.send_json(&json!({
        "type": "result",
        "requestId": request_id,
        "ok": true,
        "result": result,
    }))
}

/// Writes a byte to stderr every `HEARTBEAT_INTERVAL` while a request runs, so
/// Electron's liveness watchdog can tell a long generation from a hung process.
struct Heartbeat {
    stop: Option<mpsc::Sender<()>>,
    handle: Option<JoinHandle<()>>,
}

impl Heartbeat {
    fn start() -> Self {
        let (stop, signal) = mpsc::channel::<()>();
        let handle = thread::spawn(move || {
            loop {
                match signal.recv_timeout(HEARTBEAT_INTERVAL) {
                    Err(RecvTimeoutError::Timeout) => {
                        let mut stderr = std::io::stderr();
                        if stderr.write_all(b" ").is_err() || stderr.flush().is_err() {
                            return;
                        }
                    }
                    _ => return,
                }
            }
        });
        Self {
            stop: Some(stop),
            handle: Some(handle),
        }
    }
}

impl Drop for Heartbeat {
    fn drop(&mut self) {
        self.stop.take();
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{CANCELLED_MESSAGE, StreamedAudioSummary};
    use crate::ws::test_support::{
        Client, READ_TIMEOUT, TOKEN, connect, decode_samples, read_binary, read_json, read_message,
        send_json,
    };
    use anyhow::bail;
    use std::io::Read;
    use tungstenite::Message;
    use tungstenite::http::StatusCode;

    const FAKE_SAMPLE_RATE: usize = 24_000;
    /// Upper bound for the endless generation, so a lost cancel fails the test.
    const MAX_FAKE_CHUNKS: usize = 5_000;

    /// A backend whose payload says what to do: stream text units, stream
    /// until cancelled, return whole-text audio, return nothing, or fail.
    struct FakeBackend;

    impl FakeBackend {
        fn stream_unit(
            connection: &mut WebSocketConnection,
            request_id: &str,
            unit: usize,
            units: usize,
        ) -> Result<()> {
            let mut header = json!({
                "type": "audio_chunk",
                "requestId": request_id,
                "index": unit,
                "total": 0,
                "sampleRate": FAKE_SAMPLE_RATE,
                "sampleCount": 2,
                "silenceAfterSamples": if unit + 1 < units { 4_800 } else { 0 },
            });
            if units > 0 {
                header["textUnitIndex"] = json!(unit);
                header["textUnitTotal"] = json!(units);
            }
            connection.send_audio_chunk(&header, &[0.25, f32::NAN])
        }

        fn streamed_output(chunks: usize) -> GenerationOutput {
            GenerationOutput {
                samples: Vec::new(),
                sample_rate: FAKE_SAMPLE_RATE,
                model_repo: "fake/streaming".to_string(),
                device: Some("fake-device".to_string()),
                warnings: vec!["Fake warning.".to_string()],
                streamed_audio: Some(StreamedAudioSummary {
                    sample_count: chunks * 2,
                    audio_chunk_count: chunks,
                }),
                phase_timings: serde_json::Map::new(),
            }
        }

        fn buffered_output(samples: Vec<f32>) -> GenerationOutput {
            GenerationOutput {
                samples,
                sample_rate: FAKE_SAMPLE_RATE,
                model_repo: "fake/buffered".to_string(),
                device: None,
                warnings: Vec::new(),
                streamed_audio: None,
                phase_timings: serde_json::Map::new(),
            }
        }
    }

    impl Backend for FakeBackend {
        fn warm(&mut self, payload: Value) -> Result<Value> {
            if payload["fail"] == true {
                bail!("fake warm failure");
            }
            Ok(json!({ "warmed": true }))
        }

        fn generate(
            &mut self,
            request_id: &str,
            payload: Value,
            connection: &mut WebSocketConnection,
        ) -> Result<GenerationOutput> {
            let started = Instant::now();
            match payload["mode"].as_str().unwrap_or_default() {
                "stream" => {
                    let units = usize::try_from(payload["units"].as_u64().unwrap()).unwrap();
                    connection.bail_if_cancelled(request_id)?;
                    connection.send_progress(request_id, "inference", "Faking it.", started)?;
                    for unit in 0..units {
                        connection.bail_if_cancelled(request_id)?;
                        Self::stream_unit(connection, request_id, unit, units)?;
                    }
                    Ok(Self::streamed_output(units))
                }
                "until_cancelled" => {
                    for chunk in 0..MAX_FAKE_CHUNKS {
                        connection.bail_if_cancelled(request_id)?;
                        Self::stream_unit(connection, request_id, chunk, 0)?;
                        thread::sleep(Duration::from_millis(1));
                    }
                    Ok(Self::streamed_output(MAX_FAKE_CHUNKS))
                }
                "buffered" => {
                    let samples = usize::try_from(payload["samples"].as_u64().unwrap()).unwrap();
                    Ok(Self::buffered_output(vec![0.5; samples]))
                }
                "silent" => Ok(Self::buffered_output(Vec::new())),
                _ => bail!("fake generation failure"),
            }
        }
    }

    fn start_server() -> (SocketAddr, JoinHandle<Result<()>>) {
        let (listener, address) = bind_loopback_listener("127.0.0.1", 0).unwrap();
        let server = thread::spawn(move || serve_owner(listener, TOKEN, &mut FakeBackend));
        (address, server)
    }

    fn generate(client: &mut Client, request_id: &str, payload: Value) {
        send_json(
            client,
            json!({ "requestId": request_id, "payload": payload }),
        );
    }

    /// Reads past streamed frames to the next result envelope.
    fn read_result(client: &mut Client) -> Value {
        loop {
            if let Message::Text(text) = read_message(client) {
                let message: Value = serde_json::from_str(&text).unwrap();
                if message["type"] == "result" {
                    return message;
                }
            }
        }
    }

    fn shut_down(mut client: Client, server: JoinHandle<Result<()>>) {
        send_json(&mut client, json!({ "command": "shutdown" }));
        server.join().unwrap().unwrap();
    }

    #[test]
    fn streamed_audio_arrives_as_header_and_payload_pairs_before_the_result() {
        let (address, server) = start_server();
        let mut client = connect(address, TOKEN).unwrap();
        generate(&mut client, "r1", json!({ "mode": "stream", "units": 2 }));

        let progress = read_json(&mut client);
        assert_eq!(progress["type"], "progress");
        assert_eq!(progress["requestId"], "r1");
        assert_eq!(progress["phase"], "inference");
        assert_eq!(progress["message"], "Faking it.");
        for unit in 0..2 {
            let header = read_json(&mut client);
            assert_eq!(header["type"], "audio_chunk");
            assert_eq!(header["index"], unit);
            assert_eq!(header["textUnitIndex"], unit);
            // NaN never reaches the client.
            assert_eq!(decode_samples(&read_binary(&mut client)), [0.25, 0.0]);
        }
        let result = read_json(&mut client);
        assert_eq!(result["type"], "result");
        assert_eq!(result["requestId"], "r1");
        assert_eq!(result["ok"], true);
        assert_eq!(
            result["result"],
            json!({
                "audioChunkCount": 2,
                "audioTransport": "websocket-binary",
                "device": "fake-device",
                "durationSec": 0.0,
                "elapsedSec": 0.0,
                "modelRepo": "fake/streaming",
                "phaseTimingsSec": {},
                "sampleRate": FAKE_SAMPLE_RATE,
                "warnings": ["Fake warning."],
            })
        );
        shut_down(client, server);
    }

    #[test]
    fn whole_text_audio_is_split_into_numbered_transport_frames() {
        let (address, server) = start_server();
        let mut client = connect(address, TOKEN).unwrap();
        let samples = MAX_AUDIO_CHUNK_SAMPLES * 2 + 1_000;
        generate(
            &mut client,
            "r1",
            json!({ "mode": "buffered", "samples": samples }),
        );

        for (index, expected) in [MAX_AUDIO_CHUNK_SAMPLES, MAX_AUDIO_CHUNK_SAMPLES, 1_000]
            .into_iter()
            .enumerate()
        {
            let header = read_json(&mut client);
            assert_eq!(
                header,
                json!({
                    "type": "audio_chunk",
                    "requestId": "r1",
                    "index": index,
                    "total": 3,
                    "sampleRate": FAKE_SAMPLE_RATE,
                    "sampleCount": expected,
                    "silenceAfterSamples": 0,
                })
            );
            assert_eq!(read_binary(&mut client).len(), expected * 4);
        }
        let result = read_json(&mut client);
        assert_eq!(result["ok"], true);
        assert_eq!(result["result"]["audioChunkCount"], 3);
        assert_eq!(
            result["result"]["durationSec"],
            round_secs(samples as f64 / FAKE_SAMPLE_RATE as f64)
        );
        assert!(result["result"]["phaseTimingsSec"]["transportEncodingSec"].is_number());
        assert!(result["result"].get("device").is_none());
        assert!(result["result"].get("warnings").is_none());
        shut_down(client, server);
    }

    #[test]
    fn a_cancel_mid_generation_fails_that_request_and_keeps_serving() {
        let (address, server) = start_server();
        let mut client = connect(address, TOKEN).unwrap();
        generate(&mut client, "r1", json!({ "mode": "until_cancelled" }));
        assert_eq!(read_json(&mut client)["type"], "audio_chunk");
        send_json(
            &mut client,
            json!({ "command": "cancel", "requestId": "r1" }),
        );
        let cancelled = read_result(&mut client);
        assert_eq!(cancelled["requestId"], "r1");
        assert_eq!(cancelled["ok"], false);
        assert_eq!(cancelled["error"], CANCELLED_MESSAGE);

        // A cancel that lands between generations has nothing to abort and
        // gets no reply, and it does not leak into the next request.
        send_json(
            &mut client,
            json!({ "command": "cancel", "requestId": "r2" }),
        );
        generate(&mut client, "r2", json!({ "mode": "stream", "units": 1 }));
        let completed = read_result(&mut client);
        assert_eq!(completed["requestId"], "r2");
        assert_eq!(completed["ok"], true);
        shut_down(client, server);
    }

    #[test]
    fn protocol_errors_are_typed_results() {
        let (address, server) = start_server();
        let mut client = connect(address, TOKEN).unwrap();

        client.send(Message::Text("{".into())).unwrap();
        let invalid = read_json(&mut client);
        assert_eq!(
            invalid,
            json!({
                "type": "result",
                "requestId": "",
                "ok": false,
                "error": "Invalid WebSocket request JSON.",
                "details": "Invalid WebSocket request JSON.",
            })
        );
        send_json(&mut client, json!({ "payload": {} }));
        assert_eq!(
            read_json(&mut client)["error"],
            "WebSocket requests require a non-empty requestId."
        );
        send_json(&mut client, json!({ "requestId": "x", "command": "typo" }));
        let unsupported = read_json(&mut client);
        assert_eq!(unsupported["requestId"], "x");
        assert_eq!(unsupported["error"], "Unsupported WebSocket command.");
        send_json(
            &mut client,
            json!({ "requestId": "x", "unknownField": true }),
        );
        assert_eq!(
            read_json(&mut client)["error"],
            "Invalid WebSocket request JSON."
        );
        shut_down(client, server);
    }

    #[test]
    fn warm_requests_report_the_backend_outcome() {
        let (address, server) = start_server();
        let mut client = connect(address, TOKEN).unwrap();
        send_json(
            &mut client,
            json!({ "requestId": "w1", "command": "warm", "payload": {} }),
        );
        assert_eq!(
            read_json(&mut client),
            json!({
                "type": "result",
                "requestId": "w1",
                "ok": true,
                "result": { "warmed": true },
            })
        );
        send_json(
            &mut client,
            json!({ "requestId": "w2", "command": "warm", "payload": { "fail": true } }),
        );
        let failed = read_json(&mut client);
        assert_eq!(failed["ok"], false);
        assert_eq!(failed["error"], "fake warm failure");
        shut_down(client, server);
    }

    #[test]
    fn generation_failures_and_empty_audio_are_reported() {
        let (address, server) = start_server();
        let mut client = connect(address, TOKEN).unwrap();
        generate(&mut client, "r1", json!({ "mode": "explode" }));
        let failed = read_json(&mut client);
        assert_eq!(failed["requestId"], "r1");
        assert_eq!(failed["ok"], false);
        assert_eq!(failed["error"], "fake generation failure");
        generate(&mut client, "r2", json!({ "mode": "silent" }));
        assert_eq!(
            read_json(&mut client)["error"],
            "Generation produced no audio samples."
        );
        shut_down(client, server);
    }

    #[test]
    fn the_session_ends_when_the_owner_disconnects() {
        let (address, server) = start_server();
        let mut client = connect(address, TOKEN).unwrap();
        client.close(None).unwrap();
        server.join().unwrap().unwrap();
    }

    #[test]
    fn only_an_authorized_upgrade_becomes_the_owner() {
        let (address, server) = start_server();
        match connect(address, "wrong-token") {
            Err(tungstenite::Error::Http(response)) => {
                assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            }
            other => panic!("expected a 401, got {other:?}"),
        }
        let client = connect(address, TOKEN).unwrap();
        shut_down(client, server);
    }

    #[test]
    fn the_acceptor_closes_the_listener_once_the_owner_is_claimed() {
        // The acceptor blocks in accept() rather than polling, so the claiming
        // handshake has to wake it. Nothing else connects here, yet the
        // acceptor must stop and take the port down with it.
        let (listener, address) = bind_loopback_listener("127.0.0.1", 0).unwrap();
        let (connections, incoming) = mpsc::sync_channel(1);
        let acceptor = spawn_acceptor(listener, TOKEN.to_owned(), connections).unwrap();
        let _client = connect(address, TOKEN).unwrap();
        let _owner = incoming.recv_timeout(READ_TIMEOUT).unwrap();

        let (joined, acceptor_stopped) = mpsc::channel();
        thread::spawn(move || {
            let _ = joined.send(acceptor.join().is_ok());
        });
        assert_eq!(acceptor_stopped.recv_timeout(READ_TIMEOUT), Ok(true));
        let refused = TcpStream::connect(address).unwrap_err();
        assert_eq!(refused.kind(), std::io::ErrorKind::ConnectionRefused);
    }

    #[test]
    fn concurrent_handshakes_are_capped() {
        let (address, server) = start_server();
        let silent_peers = (0..MAX_CONCURRENT_HANDSHAKES)
            .map(|_| TcpStream::connect(address).unwrap())
            .collect::<Vec<_>>();
        // Every handshake slot is held by a peer that sent nothing, so the next
        // connection is closed at once without one. A read that times out
        // means the bridge started a handshake for it, so only a close counts.
        let mut refused = TcpStream::connect(address).unwrap();
        refused.set_read_timeout(Some(READ_TIMEOUT)).unwrap();
        let mut byte = [0_u8; 1];
        match refused.read(&mut byte) {
            Ok(0) => {}
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
            other => panic!("the connection over the cap was not closed: {other:?}"),
        }

        // Once the silent peers leave, their slots free up for the owner.
        drop(silent_peers);
        let deadline = Instant::now() + READ_TIMEOUT;
        let client = loop {
            match connect(address, TOKEN) {
                Ok(client) => break client,
                Err(error) if Instant::now() < deadline => {
                    eprintln!("retrying the owner connection: {error}");
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("the owner never got a handshake slot: {error}"),
            }
        };
        shut_down(client, server);
    }

    #[test]
    fn websocket_bind_host_must_resolve_only_to_loopback() {
        let ipv4 = resolve_loopback_bind_addresses("127.0.0.1", 0).unwrap();
        assert!(ipv4.iter().all(|address| address.ip().is_loopback()));
        let ipv6 = resolve_loopback_bind_addresses("::1", 0).unwrap();
        assert!(ipv6.iter().all(|address| address.ip().is_loopback()));

        for host in ["0.0.0.0", "::", "192.0.2.1"] {
            assert!(
                resolve_loopback_bind_addresses(host, 0)
                    .unwrap_err()
                    .to_string()
                    .contains("loopback")
            );
        }
    }

    #[test]
    fn websocket_owner_can_only_be_delivered_once() {
        let owner_delivered = AtomicBool::new(false);
        assert!(claim_websocket_owner(&owner_delivered));
        assert!(!claim_websocket_owner(&owner_delivered));
    }
}
