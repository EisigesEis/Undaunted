use std::{
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Child, Command},
};

use sha2::{Digest, Sha256};

use crate::error::CommandError;

pub const DAUNTLESS_EXE_HASH: &str =
    "d3d41e614908d2befd518b27046d9822d6130ef12ba3504babbdb786bef9cff4";
const EXECUTABLE_NAME: &str = "Dauntless-Win64-Shipping.exe";
const LAUNCH_ARGUMENTS: &[&str] = &[
    "-AUTH_LOGIN=unused",
    "-AUTH_TYPE=exchangecode",
    "-epicapp=appidlol",
    "-epicenv=Prod",
    "-EpicPortal",
    "-epicusername=usernamelol",
    "-epicuserid=useridlol",
    "-epiclocale=en-US",
    "-epicsandboxid=sandboxidlol",
    "-epicdeploymentid=deploymentidlol",
];

#[derive(Clone)]
pub struct PatchResources {
    pub dxgi: PathBuf,
    pub internal_server: PathBuf,
    pub trials_player_hunts: PathBuf,
}

pub fn win64_under(root: &Path) -> PathBuf {
    root.join("Archon").join("Binaries").join("Win64")
}

pub fn executable_in(win64: &Path) -> PathBuf {
    win64.join(EXECUTABLE_NAME)
}

pub async fn validate_win64_path(path: &Path) -> Result<bool, CommandError> {
    let executable = executable_in(path);
    if !path.is_dir() || !executable.is_file() {
        return Ok(false);
    }
    Ok(sha256_file(&executable).await? == DAUNTLESS_EXE_HASH)
}

pub async fn resolve_existing_install(root: &Path) -> Result<Option<PathBuf>, CommandError> {
    let direct = win64_under(root);
    let nested_root = root.join("Dauntless");
    let nested = win64_under(&nested_root);

    if executable_in(&direct).is_file() {
        if validate_win64_path(&direct).await? {
            return Ok(Some(direct));
        }
        return Err(invalid_install_error());
    }

    if executable_in(&nested).is_file() {
        if validate_win64_path(&nested).await? {
            return Ok(Some(nested));
        }
        return Err(invalid_install_error());
    }

    if root.join("Archon").exists() || nested_root.exists() {
        return Err(fail(
            "install_conflict",
            "The selected folder contains an incomplete or incompatible game installation.",
        ));
    }

    Ok(None)
}

pub fn patch_install(resources: &PatchResources, win64_path: &Path) -> Result<(), CommandError> {
    if !resources.dxgi.is_file()
        || !resources.internal_server.is_file()
        || !resources.trials_player_hunts.is_file()
    {
        return Err(CommandError::internal(
            "The launcher patch resources are missing.",
        ));
    }
    if !win64_path.is_dir() {
        return Err(invalid_install_error());
    }

    copy_if_different(
        &resources.dxgi,
        &win64_path.join("dxgi.dll"),
        "dxgi.dll could not be copied into the game folder.",
    )?;
    copy_if_different(
        &resources.internal_server,
        &win64_path.join("UndauntedInternalServer.dll"),
        "UndauntedInternalServer.dll could not be copied into the game folder.",
    )?;

    let content_paks = win64_path
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(|| CommandError::internal("The game content directory could not be found."))?
        .join("Content")
        .join("Paks");
    fs::create_dir_all(&content_paks).map_err(|_| {
        retry(
            "patch_failed",
            "The game Content/Paks directory could not be created.",
        )
    })?;
    copy_if_different(
        &resources.trials_player_hunts,
        &content_paks.join("TrialsPlayerHunts_P.pak"),
        "TrialsPlayerHunts_P.pak could not be copied into the game Content/Paks folder.",
    )?;
    Ok(())
}

fn copy_if_different(
    source: &Path,
    destination: &Path,
    error_message: &str,
) -> Result<(), CommandError> {
    if destination.is_file() && files_have_same_contents(source, destination).unwrap_or(false) {
        return Ok(());
    }

    fs::copy(source, destination)
        .map(|_| ())
        .map_err(|_| retry("patch_failed", error_message))
}

fn files_have_same_contents(left: &Path, right: &Path) -> io::Result<bool> {
    if fs::metadata(left)?.len() != fs::metadata(right)?.len() {
        return Ok(false);
    }

    let mut left = fs::File::open(left)?;
    let mut right = fs::File::open(right)?;
    let mut left_buffer = [0_u8; 64 * 1024];
    let mut right_buffer = [0_u8; 64 * 1024];

    loop {
        let left_count = left.read(&mut left_buffer)?;
        let right_count = right.read(&mut right_buffer)?;
        if left_count != right_count || left_buffer[..left_count] != right_buffer[..right_count] {
            return Ok(false);
        }
        if left_count == 0 {
            return Ok(true);
        }
    }
}

pub fn launch(win64_path: &Path, api_key: &str, api_url: &str) -> Result<Child, CommandError> {
    let executable = executable_in(win64_path);
    let password_argument = format!("-AUTH_PASSWORD={api_key}");
    let metagame_address = client_metagame_address(api_url)?;

    Command::new(executable)
        .current_dir(win64_path)
        .arg(metagame_address)
        .arg(password_argument)
        .args(LAUNCH_ARGUMENTS)
        .spawn()
        .map_err(|_| retry("launch_failed", "Undaunted could not be launched."))
}

pub fn validate_api_url(api_url: &str) -> Result<(), CommandError> {
    client_metagame_address(api_url).map(|_| ())
}

fn client_metagame_address(api_url: &str) -> Result<String, CommandError> {
    let parsed = reqwest::Url::parse(api_url).map_err(|_| {
        fail(
            "invalid_api_url",
            "Enter a valid API URL such as http://127.0.0.1:60000.",
        )
    })?;
    if parsed.scheme() != "http" {
        return Err(fail(
            "unsupported_api_scheme",
            "The game client currently requires an HTTP API URL.",
        ));
    }
    if parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(fail(
            "invalid_api_url",
            "The API URL must contain only a host and optional port, without a path, query, or fragment.",
        ));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| fail("invalid_api_url", "The API URL must contain a host."))?;
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    Ok(match parsed.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

pub fn read_legacy_install(root: &Path) -> Result<(PathBuf, String), CommandError> {
    let win64 = win64_under(root);
    if !executable_in(&win64).is_file() {
        return Err(invalid_install_error());
    }

    let batch_files: Vec<PathBuf> = fs::read_dir(&win64)
        .map_err(|_| invalid_install_error())?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let is_batch = path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("bat"));
            (path.is_file() && is_batch).then_some(path)
        })
        .collect();

    if batch_files.len() != 1 {
        return Err(fail(
            "legacy_batch_file",
            "The legacy install must contain exactly one .bat launcher in its Win64 folder.",
        ));
    }

    let contents = fs::read_to_string(&batch_files[0]).map_err(|_| {
        fail(
            "legacy_batch_file",
            "The legacy launcher .bat file could not be read.",
        )
    })?;
    let api_key = contents
        .split_whitespace()
        .find_map(|token| {
            let cleaned = token.trim_matches(['"', '\'']);
            let value = cleaned
                .split_once('=')
                .map(|(_, value)| value)
                .unwrap_or(cleaned)
                .trim_matches(['"', '\'']);
            value.starts_with("UUK").then(|| value.to_owned())
        })
        .ok_or_else(|| {
            fail(
                "legacy_api_key",
                "No User API Key was found in the legacy launcher .bat file.",
            )
        })?;

    Ok((win64, api_key))
}

pub async fn sha256_file(path: &Path) -> Result<String, CommandError> {
    let path = path.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let mut file = fs::File::open(path).map_err(|_| {
            retry(
                "file_read_failed",
                "A required game file could not be read.",
            )
        })?;
        let mut hash = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = file.read(&mut buffer).map_err(|_| {
                retry(
                    "file_read_failed",
                    "A required game file could not be read.",
                )
            })?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        Ok(hex_digest(&hash.finalize()))
    })
    .await
    .map_err(|_| CommandError::internal("The file verification task failed."))?
}

pub fn hex_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    bytes
        .iter()
        .flat_map(|byte| [HEX[(byte >> 4) as usize], HEX[(byte & 15) as usize]])
        .map(char::from)
        .collect()
}

fn invalid_install_error() -> CommandError {
    fail(
        "invalid_install",
        "The selected folder does not contain the supported Dauntless 1.4.4 installation.",
    )
}

fn fail(code: &str, message: &str) -> CommandError {
    CommandError::new(code, message, false)
}

fn retry(code: &str, message: &str) -> CommandError {
    CommandError::new(code, message, true)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::windows::fs::OpenOptionsExt,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{client_metagame_address, copy_if_different};

    #[test]
    fn converts_api_url_to_client_metagame_address() {
        assert_eq!(
            client_metagame_address("http://127.0.0.1:60000").unwrap(),
            "127.0.0.1:60000"
        );
        assert_eq!(
            client_metagame_address("http://api.example.test").unwrap(),
            "api.example.test"
        );
    }

    #[test]
    fn rejects_client_api_urls_the_dll_cannot_map() {
        assert!(client_metagame_address("https://api.example.test").is_err());
        assert!(client_metagame_address("http://api.example.test/base").is_err());
    }

    #[test]
    fn skips_an_identical_destination_that_is_locked_against_writes() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "undaunted-launcher-identical-copy-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("source.dll");
        let destination = directory.join("destination.dll");
        fs::write(&source, b"matching patch artifact").unwrap();
        fs::write(&destination, b"matching patch artifact").unwrap();

        // FILE_SHARE_READ permits the comparison but rejects an overwrite,
        // matching a loaded DLL that another Dauntless process is using.
        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(0x0000_0001)
            .open(&destination)
            .unwrap();

        copy_if_different(&source, &destination, "copy failed").unwrap();

        drop(locked);
        fs::remove_dir_all(directory).unwrap();
    }
}
