//! The loopback WebSocket transport between Electron's main process and this
//! bridge. It links no model runtime: `bridge-policy-tests` compiles this whole
//! directory through this file, so a native dependency here fails that build.

mod connection;
mod handshake;
mod server;
#[cfg(test)]
mod test_support;

pub use connection::WebSocketConnection;
pub use server::{Backend, bind_loopback_listener, serve_owner};
