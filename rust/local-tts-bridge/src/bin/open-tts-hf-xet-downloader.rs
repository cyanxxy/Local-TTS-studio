use std::path::PathBuf;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use clap::Parser;
use serde::Serialize;
use xet::xet_session::{HeaderMap, XetFileInfo, XetSessionBuilder};

#[derive(Parser, Debug)]
#[command(name = "open-tts-hf-xet-downloader")]
struct Args {
    #[arg(long)]
    repo: String,
    #[arg(long, default_value = "main")]
    revision: String,
    #[arg(long)]
    file: String,
    #[arg(long)]
    destination: PathBuf,
    #[arg(long, default_value_t = false)]
    metadata_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct XetResolveMetadata {
    hash: String,
    size: u64,
    token_refresh_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent<'a> {
    downloaded_bytes: u64,
    total_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    xet_hash: Option<&'a str>,
}

fn safe_hub_segment(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        && value != "."
        && value != ".."
}

fn validate_repo(repo: &str) -> Result<()> {
    let mut parts = repo.split('/');
    let owner = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    if !safe_hub_segment(owner) || !safe_hub_segment(name) || parts.next().is_some() {
        bail!("Invalid Hugging Face model repository: {repo}");
    }
    Ok(())
}

fn validate_revision(revision: &str) -> Result<()> {
    if !safe_hub_segment(revision) {
        bail!("Invalid Hugging Face revision: {revision}");
    }
    Ok(())
}

fn validate_file_path(file: &str) -> Result<()> {
    if file.contains('\0')
        || file.contains('\\')
        || file.split('/').any(|part| !safe_hub_segment(part))
    {
        bail!("Invalid Hugging Face file path: {file}");
    }
    Ok(())
}

fn parse_xet_auth_link(link: &str) -> Option<String> {
    link.split(',').find_map(|entry| {
        let entry = entry.trim();
        if !entry.contains("rel=\"xet-auth\"") {
            return None;
        }
        let start = entry.find('<')? + 1;
        let end = entry[start..].find('>')? + start;
        Some(entry[start..end].to_string())
    })
}

fn resolve_xet_metadata(repo: &str, revision: &str, file: &str) -> Result<XetResolveMetadata> {
    validate_repo(repo)?;
    validate_revision(revision)?;
    validate_file_path(file)?;

    let url = format!("https://huggingface.co/{repo}/resolve/{revision}/{file}");
    let agent = ureq::AgentBuilder::new().redirects(0).build();
    let response = match agent.head(&url).call() {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) => response,
        Err(error) => return Err(anyhow!(error)).context("Hugging Face resolve request failed"),
    };

    let hash = response
        .header("x-xet-hash")
        .filter(|value| value.bytes().all(|byte| byte.is_ascii_hexdigit()) && value.len() == 64)
        .ok_or_else(|| anyhow!("Hugging Face did not return Xet metadata for {file}"))?
        .to_string();
    let size = response
        .header("x-linked-size")
        .ok_or_else(|| anyhow!("Hugging Face did not return the size for {file}"))?
        .parse::<u64>()
        .context("Hugging Face returned an invalid Xet file size")?;
    let token_refresh_url = response
        .header("link")
        .and_then(parse_xet_auth_link)
        .ok_or_else(|| anyhow!("Hugging Face did not return a Xet authorization endpoint"))?;

    if !token_refresh_url.starts_with("https://huggingface.co/api/") {
        bail!("Hugging Face returned an unsafe Xet authorization endpoint");
    }

    Ok(XetResolveMetadata {
        hash,
        size,
        token_refresh_url,
    })
}

fn emit_progress(downloaded_bytes: u64, total_bytes: u64, xet_hash: Option<&str>) {
    if let Ok(line) = serde_json::to_string(&ProgressEvent {
        downloaded_bytes,
        total_bytes,
        xet_hash,
    }) {
        println!("{line}");
    }
}

fn run(args: Args) -> Result<()> {
    let metadata = resolve_xet_metadata(&args.repo, &args.revision, &args.file)?;
    if args.metadata_only {
        emit_progress(0, metadata.size, Some(&metadata.hash));
        return Ok(());
    }

    if let Ok(existing) = std::fs::metadata(&args.destination)
        && existing.is_file()
        && existing.len() == metadata.size
    {
        emit_progress(metadata.size, metadata.size, None);
        return Ok(());
    }

    if let Some(parent) = args.destination.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Could not create {}", parent.display()))?;
    }
    let temporary_path = PathBuf::from(format!("{}.download", args.destination.display()));
    let _ = std::fs::remove_file(&temporary_path);

    let session = XetSessionBuilder::new()
        .build()
        .context("Could not start the Xet client")?;
    let group = session
        .new_file_download_group()
        .context("Could not create the Xet download group")?
        .with_token_refresh_url(metadata.token_refresh_url.clone(), HeaderMap::new())
        .build_blocking()
        .context("Could not authorize the Xet download")?;

    let progress_group = group.clone();
    let progress_done = Arc::new(AtomicBool::new(false));
    let progress_done_thread = Arc::clone(&progress_done);
    let total_bytes = metadata.size;
    let progress_thread = thread::spawn(move || {
        while !progress_done_thread.load(Ordering::Relaxed) {
            let progress = progress_group.progress();
            emit_progress(
                progress.total_bytes_completed.min(total_bytes),
                total_bytes,
                None,
            );
            thread::sleep(Duration::from_secs(1));
        }
    });

    let result = group
        .download_file_to_path_blocking(
            XetFileInfo {
                hash: metadata.hash,
                file_size: Some(metadata.size),
                sha256: None,
            },
            temporary_path.clone(),
        )
        .and_then(|_| group.finish_blocking());
    progress_done.store(true, Ordering::Relaxed);
    let _ = progress_thread.join();

    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(error).context("Hugging Face Xet download failed");
    }
    let downloaded_size = std::fs::metadata(&temporary_path)
        .context("Xet download did not create its output file")?
        .len();
    if downloaded_size != metadata.size {
        let _ = std::fs::remove_file(&temporary_path);
        bail!(
            "Xet download was incomplete: received {downloaded_size} of {} bytes",
            metadata.size
        );
    }
    std::fs::rename(&temporary_path, &args.destination).with_context(|| {
        format!(
            "Could not move the completed download to {}",
            args.destination.display()
        )
    })?;
    emit_progress(metadata.size, metadata.size, None);
    Ok(())
}

fn main() {
    if let Err(error) = run(Args::parse()) {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_xet_auth_link() {
        let link = "<https://huggingface.co/api/models/a/b/xet-read-token/main>; rel=\"xet-auth\", <https://cas-server.xethub.hf.co/v1/reconstructions/hash>; rel=\"xet-reconstruction-info\"";
        assert_eq!(
            parse_xet_auth_link(link).as_deref(),
            Some("https://huggingface.co/api/models/a/b/xet-read-token/main")
        );
    }

    #[test]
    fn validates_hub_identifiers() {
        assert!(validate_repo("mlx-community/Qwen3-TTS").is_ok());
        assert!(validate_file_path("speech_tokenizer/model.safetensors").is_ok());
        assert!(validate_repo("mlx-community/../evil").is_err());
        assert!(validate_file_path("../model.safetensors").is_err());
        assert!(validate_file_path("a\\b").is_err());
    }
}
