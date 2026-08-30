use std::path::{Path, PathBuf};

use tauri::State;

use crate::{
    api::normalize_http_url,
    error::CommandError,
    game,
    launcher::{
        models::{
            AdminState, BackgroundAsset, Dashboard, LauncherRoute, LauncherState, RegistrationMode,
            RegistrationResult,
        },
        state::AppState,
    },
};

#[tauri::command]
pub async fn get_launcher_state(state: State<'_, AppState>) -> Result<LauncherState, CommandError> {
    launcher_state(&state).await
}

#[tauri::command]
pub fn get_runtime_config(state: State<'_, AppState>) -> Result<(String, bool), CommandError> {
    Ok((state.api.base_url(), state.credentials.get()?.is_some()))
}

#[tauri::command]
pub fn get_background(state: State<'_, AppState>) -> Result<Option<BackgroundAsset>, CommandError> {
    state.background()
}

#[tauri::command]
pub fn set_background(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<BackgroundAsset, CommandError> {
    state.set_background(PathBuf::from(file_path))
}

#[tauri::command]
pub fn clear_background(state: State<'_, AppState>) -> Result<(), CommandError> {
    state.clear_background()
}

#[tauri::command]
pub async fn get_registration_mode(
    api_url: String,
    state: State<'_, AppState>,
) -> Result<RegistrationMode, CommandError> {
    let api_url = validated_api_url(&api_url)?;
    state.api.set_api_url(&api_url);
    state.api.get_registration_mode().await
}

#[tauri::command]
pub async fn login(
    api_key: String,
    api_url: String,
    state: State<'_, AppState>,
) -> Result<LauncherState, CommandError> {
    let supplied_api_key = api_key.trim();
    let api_url = validated_api_url(&api_url)?;
    state.api.set_api_url(&api_url);
    let saved_api_key = state.credentials.get()?;
    let api_key = if supplied_api_key.is_empty() {
        saved_api_key
            .as_deref()
            .ok_or_else(CommandError::invalid_credentials)?
    } else {
        supplied_api_key
    };
    state.api.get_user_info(api_key).await?;
    state.config.set_api_url(&api_url)?;
    if !supplied_api_key.is_empty() {
        state.credentials.set(api_key)?;
    }
    state_for_valid_user(&state).await
}

#[tauri::command]
pub async fn logout(state: State<'_, AppState>) -> Result<LauncherState, CommandError> {
    state.credentials.delete()?;
    let registration_mode = state.api.get_registration_mode().await?;
    Ok(LauncherState {
        route: LauncherRoute::Login,
        registration_mode: Some(registration_mode),
    })
}

#[tauri::command]
pub async fn register_account(
    username: String,
    invite_code: Option<String>,
    api_url: String,
    state: State<'_, AppState>,
) -> Result<RegistrationResult, CommandError> {
    let api_url = validated_api_url(&api_url)?;
    state.api.set_api_url(&api_url);
    let username = username.trim();
    if username.is_empty() {
        return Err(fail("invalid_username", "Enter a username."));
    }

    let mode = state.api.get_registration_mode().await?;
    if mode == RegistrationMode::None {
        return Err(fail(
            "registration_closed",
            "Registrations are currently closed.",
        ));
    }
    let invite_code = invite_code
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if mode == RegistrationMode::InviteCode && invite_code.is_none() {
        return Err(fail("invite_code_required", "Enter an invite code."));
    }

    let api_key = state.api.register(username, invite_code).await?;
    state.config.set_api_url(&api_url)?;
    state.credentials.set(&api_key)?;
    let next_route = state_for_valid_user(&state).await?.route;
    Ok(RegistrationResult {
        api_key,
        next_route,
    })
}

#[tauri::command]
pub async fn migrate_legacy_install(
    directory: String,
    state: State<'_, AppState>,
) -> Result<LauncherState, CommandError> {
    let root = require_directory(directory)?;
    let (win64_path, api_key) = game::read_legacy_install(&root)?;
    if !game::validate_win64_path(&win64_path).await? {
        return Err(fail(
            "invalid_install",
            "The legacy installation is not the supported Dauntless 1.4.4 build.",
        ));
    }
    state.api.get_user_info(&api_key).await?;
    game::patch_install(&state.resources, &win64_path)?;
    state.config.set_game_path(win64_path)?;
    state.credentials.set(&api_key)?;
    state_for_valid_user(&state).await
}

#[tauri::command]
pub async fn use_existing_install(
    directory: String,
    state: State<'_, AppState>,
) -> Result<LauncherState, CommandError> {
    let root = require_directory(directory)?;
    let _guard = state.install_lock.try_lock().map_err(|_| {
        fail(
            "install_in_progress",
            "An Undaunted installation is already in progress.",
        )
    })?;
    let key = api_key(&state)?;
    state.api.get_user_info(&key).await?;
    let win64_path = game::resolve_existing_install(&root)
        .await?
        .ok_or_else(|| {
            fail(
                "invalid_install",
                "The selected folder does not contain the supported Dauntless 1.4.4 installation.",
            )
        })?;
    game::patch_install(&state.resources, &win64_path)?;
    state.config.set_game_path(win64_path)?;
    Ok(LauncherState {
        route: LauncherRoute::Play,
        registration_mode: None,
    })
}

#[tauri::command]
pub async fn get_dashboard(state: State<'_, AppState>) -> Result<Dashboard, CommandError> {
    let api_key = api_key(&state)?;
    let (user, version, online_players) = tokio::try_join!(
        state.api.get_user_info(&api_key),
        state.api.get_version(&api_key),
        state.api.get_online_players(&api_key),
    )?;
    Ok(Dashboard {
        username: user.username,
        version,
        online_players,
        game_running: game_running(&state)?,
        is_admin: user.is_admin,
    })
}

#[tauri::command]
pub async fn get_admin_state(state: State<'_, AppState>) -> Result<AdminState, CommandError> {
    admin_state(&state).await
}

#[tauri::command]
pub async fn set_registration_mode(
    mode: RegistrationMode,
    state: State<'_, AppState>,
) -> Result<AdminState, CommandError> {
    let key = admin_key(&state).await?;
    state.api.set_registration_mode(&key, mode).await?;
    admin_state_with_key(&state, &key).await
}

#[tauri::command]
pub async fn create_invite_code(
    code: String,
    uses: u64,
    infinite: bool,
    state: State<'_, AppState>,
) -> Result<AdminState, CommandError> {
    let code = code.trim();
    if code.is_empty() {
        return Err(fail("invalid_invite_code", "Enter an invite code."));
    }
    if !infinite && uses == 0 {
        return Err(fail(
            "invalid_invite_uses",
            "Invite codes need at least one use.",
        ));
    }
    let key = admin_key(&state).await?;
    state
        .api
        .create_invite_code(&key, code, uses, infinite)
        .await?;
    admin_state_with_key(&state, &key).await
}

#[tauri::command]
pub async fn delete_invite_code(
    code: String,
    state: State<'_, AppState>,
) -> Result<AdminState, CommandError> {
    let code = code.trim();
    if code.is_empty() {
        return Err(fail(
            "invalid_invite_code",
            "Select an invite code to delete.",
        ));
    }
    let key = admin_key(&state).await?;
    state.api.delete_invite_code(&key, code).await?;
    admin_state_with_key(&state, &key).await
}

#[tauri::command]
pub async fn launch_game(state: State<'_, AppState>) -> Result<(), CommandError> {
    let win64_path = valid_configured_path(&state).await?;
    let api_key = api_key(&state)?;
    let mut process = state
        .child
        .lock()
        .map_err(|_| CommandError::internal("The game process state is unavailable."))?;
    if let Some(child) = process.as_mut() {
        match child.try_wait() {
            Ok(None) => return Err(fail("already_running", "Undaunted is already running.")),
            Ok(Some(_)) | Err(_) => *process = None,
        }
    }
    game::patch_install(&state.resources, &win64_path)?;
    *process = Some(game::launch(&win64_path, &api_key, &state.api.base_url())?);
    Ok(())
}

#[tauri::command]
pub fn stop_game(state: State<'_, AppState>) -> Result<(), CommandError> {
    let mut process = state
        .child
        .lock()
        .map_err(|_| CommandError::internal("The game process state is unavailable."))?;
    let Some(mut child) = process.take() else {
        return Err(fail(
            "not_running",
            "No game process launched by this session is running.",
        ));
    };
    child.kill().map_err(|_| {
        CommandError::new(
            "stop_failed",
            "The game process could not be stopped.",
            true,
        )
    })?;
    let _ = child.wait();
    Ok(())
}

#[tauri::command]
pub fn is_game_running(state: State<'_, AppState>) -> Result<bool, CommandError> {
    game_running(&state)
}

async fn launcher_state(state: &AppState) -> Result<LauncherState, CommandError> {
    let Some(api_key) = state.credentials.get()? else {
        return Ok(LauncherState {
            route: LauncherRoute::Login,
            registration_mode: Some(state.api.get_registration_mode().await?),
        });
    };
    match state.api.get_user_info(&api_key).await {
        Ok(_) => state_for_valid_user(state).await,
        Err(error) if error.code == "invalid_credentials" => Ok(LauncherState {
            route: LauncherRoute::Login,
            registration_mode: Some(state.api.get_registration_mode().await?),
        }),
        Err(error) => Err(error),
    }
}

async fn state_for_valid_user(state: &AppState) -> Result<LauncherState, CommandError> {
    let route = match state.config.game_path()? {
        Some(path) if game::validate_win64_path(&path).await? => LauncherRoute::Play,
        _ => LauncherRoute::Install,
    };
    Ok(LauncherState {
        route,
        registration_mode: None,
    })
}

async fn admin_state(state: &AppState) -> Result<AdminState, CommandError> {
    let key = admin_key(state).await?;
    admin_state_with_key(state, &key).await
}

async fn admin_state_with_key(state: &AppState, key: &str) -> Result<AdminState, CommandError> {
    let (registration_mode, invite_codes) = tokio::try_join!(
        state.api.get_registration_mode(),
        state.api.get_invite_codes(key),
    )?;
    Ok(AdminState {
        registration_mode,
        invite_codes,
    })
}

async fn admin_key(state: &AppState) -> Result<String, CommandError> {
    let key = api_key(state)?;
    if !state.api.get_user_info(&key).await?.is_admin {
        return Err(CommandError::new(
            "admin_required",
            "Administrator access is required.",
            false,
        ));
    }
    Ok(key)
}

fn api_key(state: &AppState) -> Result<String, CommandError> {
    state
        .credentials
        .get()?
        .ok_or_else(CommandError::invalid_credentials)
}

fn validated_api_url(value: &str) -> Result<String, CommandError> {
    let normalized = normalize_http_url(value);
    game::validate_api_url(&normalized)?;
    Ok(normalized)
}

async fn valid_configured_path(state: &AppState) -> Result<PathBuf, CommandError> {
    let path = state.config.game_path()?.ok_or_else(|| {
        fail(
            "invalid_install",
            "Install Undaunted before launching the game.",
        )
    })?;
    if !game::validate_win64_path(&path).await? {
        return Err(fail(
            "invalid_install",
            "The configured game installation is missing or incompatible.",
        ));
    }
    Ok(path)
}

fn game_running(state: &AppState) -> Result<bool, CommandError> {
    let mut process = state
        .child
        .lock()
        .map_err(|_| CommandError::internal("The game process state is unavailable."))?;
    let Some(child) = process.as_mut() else {
        return Ok(false);
    };
    match child.try_wait() {
        Ok(None) => Ok(true),
        Ok(Some(_)) => {
            *process = None;
            Ok(false)
        }
        Err(_) => {
            *process = None;
            Err(CommandError::new(
                "process_check_failed",
                "The game process status could not be checked.",
                true,
            ))
        }
    }
}

fn require_directory(directory: String) -> Result<PathBuf, CommandError> {
    let path = Path::new(directory.trim());
    if path.is_dir() {
        Ok(path.to_owned())
    } else {
        Err(fail("invalid_directory", "Select an existing folder."))
    }
}

fn fail(code: &str, message: &str) -> CommandError {
    CommandError::new(code, message, false)
}
