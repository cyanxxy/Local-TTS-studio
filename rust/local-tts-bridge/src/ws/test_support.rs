//! Loopback peers for the transport tests: real TCP sockets on both sides, with
//! tungstenite's client role standing in for Electron.

use std::net::{SocketAddr, TcpListener, TcpStream};
use std::thread;
use std::time::Duration;

use serde_json::Value;
use tungstenite::handshake::HandshakeError;
use tungstenite::{Message, WebSocket};

use super::WebSocketConnection;

pub const TOKEN: &str = "test-token";
/// Bounds every client read, so a regression fails a test instead of hanging it.
pub const READ_TIMEOUT: Duration = Duration::from_secs(5);

pub type Client = WebSocket<TcpStream>;

/// Completes the client side of the upgrade against `address`.
pub fn connect(address: SocketAddr, token: &str) -> tungstenite::Result<Client> {
    let stream = TcpStream::connect(address)?;
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    stream.set_nodelay(true)?;
    match tungstenite::client(format!("ws://{address}/{token}"), stream) {
        Ok((client, _response)) => Ok(client),
        Err(HandshakeError::Failure(error)) => Err(error),
        Err(HandshakeError::Interrupted(_)) => unreachable!("the test stream is blocking"),
    }
}

/// A server-side connection and the client talking to it.
pub fn connected_pair() -> (WebSocketConnection, Client) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let client = thread::spawn(move || connect(address, TOKEN).unwrap());
    let (stream, _) = listener.accept().unwrap();
    let connection = WebSocketConnection::accept(stream, TOKEN).unwrap();
    (connection, client.join().unwrap())
}

pub fn read_message(client: &mut Client) -> Message {
    client.read().expect("a message from the bridge")
}

pub fn read_json(client: &mut Client) -> Value {
    match read_message(client) {
        Message::Text(text) => serde_json::from_str(&text).unwrap(),
        other => panic!("expected a text frame, got {other:?}"),
    }
}

pub fn read_binary(client: &mut Client) -> Vec<u8> {
    match read_message(client) {
        Message::Binary(bytes) => bytes.to_vec(),
        other => panic!("expected a binary frame, got {other:?}"),
    }
}

/// Little-endian Float32 samples from a binary audio frame.
pub fn decode_samples(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|sample| f32::from_le_bytes(sample.try_into().unwrap()))
        .collect()
}

pub fn send_json(client: &mut Client, message: Value) {
    client
        .send(Message::Text(message.to_string().into()))
        .unwrap();
}
