//! File moves that ride out Windows sharing violations.

use std::io;
use std::path::Path;
use std::thread;
use std::time::Duration;

const RENAME_ATTEMPTS: u32 = 5;
const RENAME_BASE_DELAY: Duration = Duration::from_millis(200);

/// `std::fs::rename`, retried on Windows while another process holds the
/// source or the target: Defender or the search indexer scanning a freshly
/// written multi-gigabyte file, or a handle that has not been released yet.
/// Elsewhere, and for every other error, it fails at once.
pub fn rename_with_retry(from: &Path, to: &Path) -> io::Result<()> {
    rename_retrying(
        from,
        to,
        |from, to| std::fs::rename(from, to),
        cfg!(windows),
        RENAME_BASE_DELAY,
    )
}

fn rename_retrying(
    from: &Path,
    to: &Path,
    mut rename: impl FnMut(&Path, &Path) -> io::Result<()>,
    retry: bool,
    base_delay: Duration,
) -> io::Result<()> {
    let mut attempt = 1;
    loop {
        match rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) if retry && attempt < RENAME_ATTEMPTS && is_sharing_violation(&error) => {
                thread::sleep(base_delay * attempt);
                attempt += 1;
            }
            Err(error) => return Err(error),
        }
    }
}

/// `ERROR_ACCESS_DENIED` (5), `ERROR_SHARING_VIOLATION` (32) and
/// `ERROR_LOCK_VIOLATION` (33): what Windows reports for a file another
/// process has open.
fn is_sharing_violation(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied
        || matches!(error.raw_os_error(), Some(5 | 32 | 33))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sharing_violation() -> io::Error {
        io::Error::from_raw_os_error(32)
    }

    #[test]
    fn retries_a_sharing_violation_until_the_rename_lands() {
        let mut calls = 0;
        let result = rename_retrying(
            Path::new("a"),
            Path::new("b"),
            |_, _| {
                calls += 1;
                if calls < 3 {
                    Err(sharing_violation())
                } else {
                    Ok(())
                }
            },
            true,
            Duration::ZERO,
        );
        assert!(result.is_ok());
        assert_eq!(calls, 3);
    }

    #[test]
    fn gives_up_after_the_last_attempt() {
        let mut calls = 0;
        let result = rename_retrying(
            Path::new("a"),
            Path::new("b"),
            |_, _| {
                calls += 1;
                Err(sharing_violation())
            },
            true,
            Duration::ZERO,
        );
        assert!(result.is_err());
        assert_eq!(calls, RENAME_ATTEMPTS);
    }

    #[test]
    fn fails_at_once_without_retries_or_on_other_errors() {
        let mut calls = 0;
        let result = rename_retrying(
            Path::new("a"),
            Path::new("b"),
            |_, _| {
                calls += 1;
                Err(sharing_violation())
            },
            false,
            Duration::ZERO,
        );
        assert!(result.is_err());
        assert_eq!(calls, 1);

        calls = 0;
        let result = rename_retrying(
            Path::new("a"),
            Path::new("b"),
            |_, _| {
                calls += 1;
                Err(io::Error::from(io::ErrorKind::NotFound))
            },
            true,
            Duration::ZERO,
        );
        assert!(result.is_err());
        assert_eq!(calls, 1);
    }
}
