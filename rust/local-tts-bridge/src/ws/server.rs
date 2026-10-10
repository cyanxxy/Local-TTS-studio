//! The loopback listener, the single owning connection, and the request loop
//! that drives a model backend.

use std::io::Write;
use std::net::{SocketAddr, TcpListener, ToSocketAddrs};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

use super::connection::{WebSocketConnection, is_client_disconnect};
use crate::protocol::{
    GenerationOutput, MAX_AUDIO_CHUNK_SAMPLES, WebSocketRequest, float32_to_le_bytes,
    is_elapsed_phase_timing, round_secs, validate_generation_output,
};

// Handshakes run on their own threads so one slow or silent peer cannot stall
// the accept loop past the client's connect budget. Cap the concurrent
// handshakes so that indirection is not itself an unbounded-thread vector.
const MAX_CONCURRENT_HANDSHAKES: usize = 8;
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
    // The handshake (header read, token check, upgrade write) runs off the
    // accept loop: a peer that connects and then goes silent would otherwise
    // hold the loop for the whole handshake deadline and lock the legitimate
    // client out for longer than its connect budget.
    listener
        .set_nonblocking(true)
        .context("Failed configuring WebSocket listener")?;
    // There is exactly one process owner. The bounded channel is a backstop;
    // the atomic claim below is what prevents every later completed handshake
    // from retaining a socket after the receiver has taken that owner.
    let (connections, incoming) = mpsc::sync_channel::<WebSocketConnection>(1);
    let in_flight = Arc::new(AtomicUsize::new(0));
    let owner_delivered = Arc::new(AtomicBool::new(false));
    let accept_owner_delivered = Arc::clone(&owner_delivered);
    let auth_token = auth_token.to_owned();
    thread::spawn(move || {
        loop {
            if accept_owner_delivered.load(Ordering::Acquire) {
                return;
            }
            // Dropping the sender on a listener failure surfaces as a recv
            // error below, matching the previous fatal-accept-error behaviour
            // instead of spinning on a socket that will never accept again.
            let (stream, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                    continue;
                }
                Err(_) => return,
            };
            // A connection can arrive between the pre-accept ownership check
            // and accept itself. Close it without starting another handshake.
            if accept_owner_delivered.load(Ordering::Acquire) {
                return;
            }
            let _ = stream.set_nodelay(true);
            if in_flight.fetch_add(1, Ordering::SeqCst) >= MAX_CONCURRENT_HANDSHAKES {
                in_flight.fetch_sub(1, Ordering::SeqCst);
                eprintln!("WebSocket bridge refused a connection: too many pending handshakes.");
                continue;
            }
            let auth_token = auth_token.clone();
            let connections = connections.clone();
            let handshake_in_flight = Arc::clone(&in_flight);
            let handshake_owner_delivered = Arc::clone(&accept_owner_delivered);
            if thread::Builder::new()
                .name("ws-handshake".to_string())
                .spawn(move || {
                    match WebSocketConnection::accept(stream, &auth_token) {
                        Ok(connection) => {
                            if claim_websocket_owner(&handshake_owner_delivered) {
                                // The receiver is waiting for this sole owner.
                                // If it disappeared unexpectedly, dropping the
                                // connection here still closes the stream.
                                let _ = connections.send(connection);
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
    });

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

fn claim_websocket_owner(owner_delivered: &AtomicBool) -> bool {
    owner_delivered
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
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
            websocket.send_json(&json!({
                "type": "audio_chunk",
                "requestId": request_id,
                "index": index,
                "total": chunk_count,
                "sampleRate": output.sample_rate,
                "sampleCount": chunk.len(),
                "silenceAfterSamples": 0,
            }))?;
            websocket.send_binary(float32_to_le_bytes(chunk))?;
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
