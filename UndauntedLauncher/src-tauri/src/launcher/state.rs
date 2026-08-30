use std::{
    fs,
    path::{Path, PathBuf},
    process::Child,
    sync::Mutex,
};

use tauri::{AppHandle, Manager, path::BaseDirectory};

use crate::{
    api::ApiClient,
    error::CommandError,
    game::PatchResources,
    launcher::models::BackgroundAsset,
    storage::{config::ConfigStore, credentials::Credentials},
};

pub struct AppState {
    pub api: ApiClient,
    pub config: ConfigStore,
    pub credentials: Credentials,
    pub resources: PatchResources,
    pub background_dir: PathBuf,
    pub child: Mutex<Option<Child>>,
    pub install_lock: tokio::sync::Mutex<()>,
}

impl AppState {
    pub fn new(app: &AppHandle) -> Result<Self, CommandError> {
        let config_path = dirs::data_local_dir()
            .ok_or_else(|| CommandError::internal("The local app data path is unavailable."))?
            .join("Undaunted Launcher")
            .join("config.json");
        let background_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|_| CommandError::internal("The launcher background folder is unavailable."))?
            .join("backgrounds");
        let config = ConfigStore::load(config_path)?;
        let credentials = Credentials;
        config.import_legacy_once(&credentials)?;
        let dxgi = resolve_resource(app, "game-patch/dxgi.dll")?;
        let internal_server = resolve_resource(app, "game-patch/UndauntedInternalServer.dll")?;
        let trials_player_hunts = resolve_resource(app, "game-patch/TrialsPlayerHunts_P.pak")?;

        Ok(Self {
            api: ApiClient::from_runtime(config.api_url()?)?,
            config,
            credentials,
            resources: PatchResources {
                dxgi,
                internal_server,
                trials_player_hunts,
            },
            background_dir,
            child: Mutex::new(None),
            install_lock: tokio::sync::Mutex::new(()),
        })
    }

    pub fn import_legacy_once(&self) -> Result<(), CommandError> {
        self.config.import_legacy_once(&self.credentials)
    }

    pub fn background(&self) -> Result<Option<BackgroundAsset>, CommandError> {
        let Some(file_name) = self.config.background_file_name()? else {
            return Ok(None);
        };
        if Path::new(&file_name).file_name() != Some(std::ffi::OsStr::new(&file_name)) {
            self.config.set_background_file_name(None)?;
            return Ok(None);
        }
        let path = self.background_dir.join(&file_name);
        if !path.is_file() {
            self.config.set_background_file_name(None)?;
            return Ok(None);
        }
        Ok(Some(BackgroundAsset {
            path: path.to_string_lossy().into_owned(),
            media_type: background_media_type(&path)?.to_owned(),
        }))
    }

    pub fn set_background(&self, source: PathBuf) -> Result<BackgroundAsset, CommandError> {
        if !source.is_file() {
            return Err(CommandError::new(
                "invalid_background",
                "Select an existing image or video file.",
                false,
            ));
        }
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .ok_or_else(|| {
                CommandError::new(
                    "invalid_background",
                    "Choose a PNG, JPEG, WebP, GIF, MP4, WebM, or OGV file.",
                    false,
                )
            })?;
        let media_type = background_media_type_from_extension(&extension).ok_or_else(|| {
            CommandError::new(
                "invalid_background",
                "Choose a PNG, JPEG, WebP, GIF, MP4, WebM, or OGV file.",
                false,
            )
        })?;
        fs::create_dir_all(&self.background_dir).map_err(|_| {
            CommandError::internal("The launcher background folder could not be created.")
        })?;
        let file_name = format!("background.{extension}");
        let destination = self.background_dir.join(&file_name);
        let temporary = self
            .background_dir
            .join(format!("background.{}.tmp", std::process::id()));
        if let Err(_) = fs::copy(&source, &temporary) {
            let _ = fs::remove_file(&temporary);
            return Err(CommandError::new(
                "background_copy_failed",
                "The selected background could not be copied.",
                true,
            ));
        }
        if destination.exists() {
            fs::remove_file(&destination).map_err(|_| {
                CommandError::new(
                    "background_copy_failed",
                    "The previous background could not be replaced.",
                    true,
                )
            })?;
        }
        if let Some(previous) = self.config.background_file_name()? {
            let previous_path = self.background_dir.join(previous);
            if previous_path != destination && previous_path.is_file() {
                let _ = fs::remove_file(previous_path);
            }
        }
        fs::rename(&temporary, &destination).map_err(|_| {
            let _ = fs::remove_file(&temporary);
            CommandError::new(
                "background_copy_failed",
                "The selected background could not be saved.",
                true,
            )
        })?;
        self.config.set_background_file_name(Some(file_name))?;
        Ok(BackgroundAsset {
            path: destination.to_string_lossy().into_owned(),
            media_type: media_type.to_owned(),
        })
    }

    pub fn clear_background(&self) -> Result<(), CommandError> {
        if let Some(previous) = self.config.background_file_name()? {
            let path = self.background_dir.join(previous);
            if path.is_file() {
                let _ = fs::remove_file(path);
            }
        }
        self.config.set_background_file_name(None)
    }
}

fn background_media_type(path: &Path) -> Result<&'static str, CommandError> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    extension
        .as_deref()
        .and_then(background_media_type_from_extension)
        .ok_or_else(|| {
            CommandError::new(
                "invalid_background",
                "The saved launcher background has an unsupported format.",
                false,
            )
        })
}

fn background_media_type_from_extension(extension: &str) -> Option<&'static str> {
    match extension {
        "png" | "jpg" | "jpeg" | "webp" | "gif" => Some("image"),
        "mp4" | "webm" | "ogv" => Some("video"),
        _ => None,
    }
}

fn resolve_resource(app: &AppHandle, path: &str) -> Result<PathBuf, CommandError> {
    app.path()
        .resolve(path, BaseDirectory::Resource)
        .map_err(|_| CommandError::internal("A bundled launcher resource is unavailable."))
}
