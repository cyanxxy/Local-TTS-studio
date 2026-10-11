//! Command-line interface. Electron is the only caller, so unknown flags are
//! rejected rather than ignored.

use std::path::PathBuf;

use clap::{Parser, ValueEnum};

#[derive(Debug, Parser)]
#[command(about = "Open TTS local runtime bridge")]
pub struct Cli {
    #[arg(long, value_enum)]
    pub action: Action,
    #[arg(long, value_enum)]
    pub model: LocalModel,
    #[arg(long)]
    pub cache_dir: PathBuf,
    #[arg(long, default_value = "127.0.0.1")]
    pub host: String,
    #[arg(long, default_value_t = 0)]
    pub port: u16,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
#[value(rename_all = "kebab-case")]
pub enum Action {
    Probe,
    ServeWs,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
#[value(rename_all = "kebab-case")]
pub enum LocalModel {
    Neutts,
    Qwen3,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serve_ws_defaults_to_loopback_and_an_ephemeral_port() {
        let cli = Cli::try_parse_from([
            "open-tts-local-bridge",
            "--action",
            "serve-ws",
            "--model",
            "qwen3",
            "--cache-dir",
            "/tmp/cache",
        ])
        .unwrap();
        assert_eq!(cli.action, Action::ServeWs);
        assert_eq!(cli.model, LocalModel::Qwen3);
        assert_eq!(cli.host, "127.0.0.1");
        assert_eq!(cli.port, 0);
    }

    #[test]
    fn unknown_arguments_and_values_are_rejected() {
        let base = [
            "open-tts-local-bridge",
            "--action",
            "probe",
            "--model",
            "neutts",
            "--cache-dir",
            "/tmp/cache",
        ];
        assert!(Cli::try_parse_from(base).is_ok());
        let mut legacy_token = base.to_vec();
        legacy_token.extend(["--auth-token", "secret"]);
        assert!(Cli::try_parse_from(legacy_token).is_err());
        let mut unknown_model = base.to_vec();
        unknown_model[4] = "kokoro";
        assert!(Cli::try_parse_from(unknown_model).is_err());
    }
}
