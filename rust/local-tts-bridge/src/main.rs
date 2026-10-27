//! Open TTS local runtime bridge. Electron spawns one process per model and
//! either probes it once or talks to it over an authenticated loopback
//! WebSocket (`ws`); `neutts_backend` and `qwen3` are the models it can host.

mod cli;
mod neucodec_encoder;
mod neutts_backend;
mod qwen3;

use std::io::{Read, Write};
use std::thread;

use anyhow::{Context, Result};
use clap::Parser;
use open_tts_bridge_core::{protocol, reference_audio, resident_model, ws};
use serde_json::{Value, json};

use cli::{Action, Cli, LocalModel};

const RESULT_PREFIX: &str = "__RESULT__";
const PORT_PREFIX: &str = "__PORT__";

fn main() {
    let cli = Cli::parse();
    let result = match cli.action {
        Action::Probe => run_probe(&cli),
        Action::ServeWs => run_websocket_server(&cli),
    };

    if let Err(err) = result {
        let _ = emit_result(&json!({
            "ok": false,
            "error": err.to_string(),
            "details": format!("{err:#}"),
        }));
        std::process::exit(1);
    }
}

fn emit_result(payload: &Value) -> Result<()> {
    println!("{RESULT_PREFIX}{}", serde_json::to_string(payload)?);
    Ok(())
}

fn create_cache_dir(cli: &Cli) -> Result<()> {
    std::fs::create_dir_all(&cli.cache_dir).with_context(|| {
        format!(
            "Failed to create cache directory {}",
            cli.cache_dir.display()
        )
    })
}

fn run_probe(cli: &Cli) -> Result<()> {
    create_cache_dir(cli)?;
    let result = match cli.model {
        LocalModel::Qwen3 => qwen3::probe_result(),
        LocalModel::Neutts => neutts_backend::probe_result(),
    };
    emit_result(&json!({ "ok": true, "result": result }))
}

fn run_websocket_server(cli: &Cli) -> Result<()> {
    let auth_token = std::env::var("OPEN_TTS_WS_AUTH_TOKEN")
        .ok()
        .filter(|token| !token.is_empty())
        .context("WebSocket bridge requires a non-empty authentication token.")?;
    create_cache_dir(cli)?;

    let (listener, local_address) = ws::bind_loopback_listener(&cli.host, cli.port)?;
    println!("{PORT_PREFIX}{}", local_address.port());
    std::io::stdout()
        .flush()
        .context("Failed announcing WebSocket bridge port")?;
    exit_when_parent_pipe_closes();

    match cli.model {
        LocalModel::Qwen3 => {
            ws::serve_owner(listener, &auth_token, &mut qwen3::Qwen3Backend::new())
        }
        LocalModel::Neutts => ws::serve_owner(
            listener,
            &auth_token,
            &mut neutts_backend::NeuttsBackend::new(cli.cache_dir.clone()),
        ),
    }
}

fn exit_when_parent_pipe_closes() {
    thread::spawn(|| {
        let mut input = std::io::stdin().lock();
        let mut byte = [0_u8; 1];
        loop {
            match input.read(&mut byte) {
                Ok(0) => std::process::exit(0),
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => std::process::exit(0),
            }
        }
    });
}

/// The version Cargo.lock pins for `package`, so tests can keep the package
/// versions the probes report from drifting.
#[cfg(test)]
fn locked_package_version(package: &str) -> Option<String> {
    let lockfile = include_str!("../../Cargo.lock");
    let name_line = format!("name = \"{package}\"");
    let mut lines = lockfile.lines();
    lines.find(|line| *line == name_line)?;
    lines
        .next()?
        .strip_prefix("version = \"")?
        .strip_suffix('"')
        .map(str::to_owned)
}
