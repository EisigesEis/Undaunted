use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
};

use serde::{Deserialize, Serialize};

use crate::{error::CommandError, storage::credentials::Credentials};

#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct LauncherConfig {
    #[serde(rename = "schemaVersion")]
    _schema_version: u8,
    dauntless_win64_path: Option<PathBuf>,
    api_url: Option<String>,
    background_file_name: Option<String>,
    legacy_import_completed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct LegacyConfig {
    #[serde(alias = "gamePath")]
    dauntless_win64_path: Option<PathBuf>,
    #[serde(rename = "UndauntedUserAPIKey")]
    undaunted_user_api_key: Option<String>,
    #[serde(alias = "ApiUrl", alias = "apiUrl", alias = "APIUrl")]
    api_url: Option<String>,
}

pub struct ConfigStore(PathBuf);

impl ConfigStore {
    pub fn load(path: PathBuf) -> Result<Self, CommandError> {
        let store = Self(path);
        store.read()?;
        Ok(store)
    }

    pub fn game_path(&self) -> Result<Option<PathBuf>, CommandError> {
        Ok(self.read()?.dauntless_win64_path)
    }

    pub fn api_url(&self) -> Result<Option<String>, CommandError> {
        Ok(self.read()?.api_url)
    }

    pub fn set_api_url(&self, value: &str) -> Result<(), CommandError> {
        let mut config = self.read()?;
        config.api_url = Some(value.trim_end_matches('/').to_owned());
        self.write(&config)
    }

    pub fn set_game_path(&self, path: PathBuf) -> Result<(), CommandError> {
        let mut config = self.read()?;
        config.dauntless_win64_path = Some(path);
        self.write(&config)
    }

    pub fn background_file_name(&self) -> Result<Option<String>, CommandError> {
        Ok(self.read()?.background_file_name)
    }

    pub fn set_background_file_name(&self, value: Option<String>) -> Result<(), CommandError> {
        let mut config = self.read()?;
        config.background_file_name = value;
        self.write(&config)
    }

    pub fn import_legacy_once(&self, credentials: &Credentials) -> Result<(), CommandError> {
        let mut config = self.read()?;
        let staged =
            dirs::data_local_dir().map(|p| p.join("Undaunted Launcher").join("legacy-config.json"));
        let legacy = dirs::config_dir().map(|p| p.join("Undaunted Launcher").join("config.json"));
        if config.legacy_import_completed
            && !staged.as_ref().is_some_and(|p| p.is_file())
            && !legacy.as_ref().is_some_and(|p| p.is_file())
        {
            return Ok(());
        }
        let Some(path) = staged
            .as_ref()
            .filter(|p| p.is_file())
            .or(legacy.as_ref().filter(|p| p.is_file()))
        else {
            return Ok(());
        };
        let value = fs::read_to_string(path).map_err(|_| {
            CommandError::internal("The legacy launcher settings could not be read.")
        })?;
        let legacy = serde_json::from_str::<LegacyConfig>(&value)
            .map_err(|_| CommandError::internal("The legacy launcher settings are invalid."))?;
        config.dauntless_win64_path = config.dauntless_win64_path.or(legacy.dauntless_win64_path);
        config.api_url = config
            .api_url
            .or(legacy.api_url.filter(|v| !v.trim().is_empty()));
        if credentials.get()?.is_none()
            && let Some(key) = legacy
                .undaunted_user_api_key
                .filter(|v| !v.trim().is_empty())
        {
            credentials.set(key.trim())?;
        }
        config.legacy_import_completed = true;
        self.write(&config)?;
        if let Some(path) = staged {
            let _ = fs::remove_file(path);
        }
        if let Some(path) = dirs::config_dir().map(|p| p.join("Undaunted Launcher"))
            && path.is_dir()
        {
            let _ = fs::remove_dir_all(path);
        }
        Ok(())
    }

    fn read(&self) -> Result<LauncherConfig, CommandError> {
        if !self.0.exists() {
            return Ok(LauncherConfig {
                _schema_version: 1,
                ..Default::default()
            });
        }
        let value = fs::read_to_string(&self.0)
            .map_err(|_| CommandError::internal("The launcher config could not be read."))?;
        serde_json::from_str(&value)
            .map_err(|_| CommandError::internal("The launcher config is invalid."))
    }

    fn write(&self, config: &LauncherConfig) -> Result<(), CommandError> {
        let parent = self
            .0
            .parent()
            .ok_or_else(|| CommandError::internal("The config path is invalid."))?;
        fs::create_dir_all(parent)
            .map_err(|_| CommandError::internal("The config directory could not be created."))?;
        let temporary = self.0.with_extension(format!("tmp-{}", std::process::id()));
        let data = serde_json::to_vec(config)
            .map_err(|_| CommandError::internal("The config could not be serialized."))?;
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)
            .map_err(|_| CommandError::internal("The config could not be written."))?;
        file.write_all(&data)
            .and_then(|()| file.sync_all())
            .map_err(|_| CommandError::internal("The config could not be written."))?;
        drop(file);
        fs::rename(&temporary, &self.0).map_err(|_| {
            let _ = fs::remove_file(temporary);
            CommandError::internal("The config could not be committed.")
        })
    }
}
