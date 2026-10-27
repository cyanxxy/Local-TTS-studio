//! The loopback WebSocket transport between Electron's main process and the
//! bridge. It links no model runtime; backends plug in through [`Backend`].

mod connection;
mod handshake;
mod server;
#[cfg(test)]
mod test_support;

pub use connection::WebSocketConnection;
pub use server::{Backend, bind_loopback_listener, serve_owner};
