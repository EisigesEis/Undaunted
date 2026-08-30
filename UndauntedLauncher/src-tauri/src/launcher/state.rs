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
    app: AppHandle,
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
            app: app.clone(),
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
        if let Some(path) = self.config.external_background_video_path()? {
            if !path.is_file() || background_media_type(&path).ok() != Some("video") {
                self.config.clear_background()?;
                return Ok(None);
            }
            self.allow_external_background(&path)?;
            return Ok(Some(BackgroundAsset {
                path: path.to_string_lossy().into_owned(),
                media_type: "video".to_owned(),
            }));
        }
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

    pub async fn set_background(&self, source: PathBuf) -> Result<BackgroundAsset, CommandError> {
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
        if media_type == "video" {
            let path = source.canonicalize().map_err(|_| {
                CommandError::new(
                    "invalid_background",
                    "The selected video path could not be resolved.",
                    false,
                )
            })?;
            self.allow_external_background(&path)?;
            let previous = self.config.background_file_name()?;
            self.config
                .set_external_background_video_path(Some(path.clone()))?;
            self.remove_managed_background(previous);
            return Ok(BackgroundAsset {
                path: path.to_string_lossy().into_owned(),
                media_type: "video".to_owned(),
            });
        }
        fs::create_dir_all(&self.background_dir).map_err(|_| {
            CommandError::internal("The launcher background folder could not be created.")
        })?;
        let file_name = format!("background.{extension}");
        let destination = self.background_dir.join(&file_name);
        let temporary = self
            .background_dir
            .join(format!("background.{}.tmp", std::process::id()));
        let backup = self
            .background_dir
            .join(format!("background.{}.previous", std::process::id()));
        let copy_source = source.clone();
        let copy_temporary = temporary.clone();
        let copied = tokio::task::spawn_blocking(move || fs::copy(copy_source, copy_temporary))
            .await
            .map_err(|_| {
                CommandError::new(
                    "background_copy_failed",
                    "The background copy task could not be completed.",
                    true,
                )
            })?;
        if copied.is_err() {
            let _ = fs::remove_file(&temporary);
            return Err(CommandError::new(
                "background_copy_failed",
                "The selected background could not be copied.",
                true,
            ));
        }
        let previous = self.config.background_file_name()?;
        let replacing_destination = destination.is_file();
        if backup.is_file() {
            let _ = fs::remove_file(&backup);
        }
        if replacing_destination {
            fs::rename(&destination, &backup).map_err(|_| {
                CommandError::new(
                    "background_copy_failed",
                    "The previous background could not be replaced.",
                    true,
                )
            })?;
        }
        if fs::rename(&temporary, &destination).is_err() {
            let _ = fs::remove_file(&temporary);
            if replacing_destination {
                let _ = fs::rename(&backup, &destination);
            }
            return Err(CommandError::new(
                "background_copy_failed",
                "The selected background could not be saved.",
                true,
            ));
        }
        if let Err(error) = self.config.set_background_file_name(Some(file_name)) {
            let _ = fs::remove_file(&destination);
            if replacing_destination {
                let _ = fs::rename(&backup, &destination);
            }
            return Err(error);
        }
        if backup.is_file() {
            let _ = fs::remove_file(&backup);
        }
        self.remove_managed_background(
            previous.filter(|name| self.background_dir.join(name) != destination),
        );
        Ok(BackgroundAsset {
            path: destination.to_string_lossy().into_owned(),
            media_type: media_type.to_owned(),
        })
    }

    pub fn clear_background(&self) -> Result<(), CommandError> {
        let previous = self.config.background_file_name()?;
        self.config.clear_background()?;
        self.remove_managed_background(previous);
        Ok(())
    }

    fn allow_external_background(&self, path: &Path) -> Result<(), CommandError> {
        self.app
            .asset_protocol_scope()
            .allow_file(path)
            .map_err(|_| {
                CommandError::new(
                    "background_access_failed",
                    "The launcher could not access the selected video.",
                    true,
                )
            })
    }

    fn remove_managed_background(&self, file_name: Option<String>) {
        let Some(file_name) = file_name else { return };
        if Path::new(&file_name).file_name() != Some(std::ffi::OsStr::new(&file_name)) {
            return;
        }
        let path = self.background_dir.join(file_name);
        if path.is_file() {
            let _ = fs::remove_file(path);
        }
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
