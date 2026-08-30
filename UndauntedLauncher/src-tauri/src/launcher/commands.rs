use std::path::{Path, PathBuf};

use tauri::State;

use crate::{
    api::normalize_http_url,
    error::CommandError,
    game,
    launcher::{
        models::{
            AdminState, BackgroundAsset, CredentialBootstrap, CredentialProfile, Dashboard,
            LauncherRoute, LauncherState, RegistrationMode, RegistrationResult,
        },
        state::AppState,
    },
};

#[tauri::command]
pub async fn get_launcher_state(state: State<'_, AppState>) -> Result<LauncherState, CommandError> {
    launcher_state(&state).await
}

#[tauri::command]
pub fn get_credential_bootstrap(
    state: State<'_, AppState>,
) -> Result<CredentialBootstrap, CommandError> {
    credential_bootstrap(&state)
}

#[tauri::command]
pub fn get_credential_profile_key(
    profile_id: String,
    state: State<'_, AppState>,
) -> Result<String, CommandError> {
    if profile_id == crate::storage::credentials::LEGACY_ACCOUNT {
        return state
            .credentials
            .get()?
            .ok_or_else(CommandError::invalid_credentials);
    }
    let exists = state
        .config
        .credential_profiles()?
        .iter()
        .any(|profile| profile.id == profile_id);
    if !exists {
        return Err(CommandError::invalid_credentials());
    }
    state
        .credentials
        .get_account(&profile_id)?
        .ok_or_else(CommandError::invalid_credentials)
}

#[tauri::command]
pub fn delete_credential_profile(
    profile_id: String,
    state: State<'_, AppState>,
) -> Result<CredentialBootstrap, CommandError> {
    if profile_id == crate::storage::credentials::LEGACY_ACCOUNT {
        state.credentials.delete()?;
        state.config.set_active_credential_profile_id(None)?;
        return credential_bootstrap(&state);
    }
    let mut profiles = state.config.credential_profiles()?;
    if !profiles.iter().any(|profile| profile.id == profile_id) {
        return credential_bootstrap(&state);
    };
    let profile_key = state.credentials.get_account(&profile_id)?;
    let deleting_active = state.config.active_credential_profile_id()?.as_deref()
        == Some(&profile_id)
        || (profile_key.is_some() && profile_key.as_deref() == state.credentials.get()?.as_deref());
    state.credentials.delete_account(&profile_id)?;
    profiles.retain(|item| item.id != profile_id);
    state.config.set_credential_profiles(profiles)?;
    if deleting_active {
        state.config.set_active_credential_profile_id(None)?;
        state.credentials.delete()?;
    }
    credential_bootstrap(&state)
}

#[tauri::command]
pub fn copy_user_api_key(api_key: String, app: tauri::AppHandle) -> Result<(), CommandError> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_text(api_key)
        .map_err(|_| CommandError::internal("The UUK could not be copied to the clipboard."))
}

#[tauri::command]
pub fn get_background(state: State<'_, AppState>) -> Result<Option<BackgroundAsset>, CommandError> {
    state.background()
}

#[tauri::command]
pub async fn set_background(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<BackgroundAsset, CommandError> {
    state.set_background(PathBuf::from(file_path)).await
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
    let saved_api_key = active_api_key(&state)?;
    let api_key = if supplied_api_key.is_empty() {
        saved_api_key
            .as_deref()
            .ok_or_else(CommandError::invalid_credentials)?
    } else {
        supplied_api_key
    };
    let user = state.api.get_user_info(api_key).await?;
    state.config.set_api_url(&api_url)?;
    save_profile(&state, &api_url, &user, api_key)?;
    state_for_valid_user(&state).await
}

#[tauri::command]
pub fn logout() -> Result<LauncherState, CommandError> {
    Ok(LauncherState {
        route: LauncherRoute::Login,
        registration_mode: None,
    })
}

fn credential_bootstrap(state: &AppState) -> Result<CredentialBootstrap, CommandError> {
    let mut profiles = state.config.credential_profiles()?;
    let mut configured_active = state.config.active_credential_profile_id()?;
    let profile_count_before_cleanup = profiles.len();
    profiles.retain(|profile| {
        state
            .credentials
            .get_account(&profile.id)
            .ok()
            .flatten()
            .is_some()
    });
    if profiles.len() != profile_count_before_cleanup {
        state.config.set_credential_profiles(profiles.clone())?;
    }
    if configured_active
        .as_ref()
        .is_some_and(|id| !profiles.iter().any(|profile| &profile.id == id))
    {
        configured_active = None;
        state.config.set_active_credential_profile_id(None)?;
    }
    if configured_active.is_none()
        && let Some(legacy_key) = state.credentials.get()?
    {
        let api_url = state.api.base_url();
        let legacy_id = profile_id(&api_url, "legacy");
        state.credentials.set_account(&legacy_id, &legacy_key)?;
        profiles.retain(|profile| profile.id != legacy_id);
        profiles.push(CredentialProfile {
            id: legacy_id.clone(),
            api_url,
            user_id: String::new(),
            username: "Saved account".to_owned(),
        });
        state.config.set_credential_profiles(profiles.clone())?;
        state
            .config
            .set_active_credential_profile_id(Some(legacy_id.clone()))?;
        state.credentials.delete()?;
        configured_active = Some(legacy_id);
    }
    let active_profile_id = configured_active.filter(|id| {
        profiles.iter().any(|profile| &profile.id == id)
            && state.credentials.get_account(id).ok().flatten().is_some()
    });

    Ok(CredentialBootstrap {
        api_url: state.api.base_url(),
        profiles,
        active_profile_id,
    })
}

fn save_profile(
    state: &AppState,
    api_url: &str,
    user: &crate::api::UserInfo,
    key: &str,
) -> Result<(), CommandError> {
    let id = profile_id(api_url, &user.user_id);
    state.credentials.set_account(&id, key)?;
    let mut profiles = state.config.credential_profiles()?;
    let mut replaced_accounts = Vec::new();
    for profile in &profiles {
        if profile.id == id {
            continue;
        }
        let same_identity = profile.api_url == api_url && profile.user_id == user.user_id;
        let same_saved_key = profile.api_url == api_url
            && state.credentials.get_account(&profile.id)?.as_deref() == Some(key);
        if same_identity || same_saved_key {
            replaced_accounts.push(profile.id.clone());
        }
    }
    profiles.retain(|profile| {
        profile.id != id
            && !replaced_accounts
                .iter()
                .any(|account| account == &profile.id)
    });
    profiles.push(CredentialProfile {
        id: id.clone(),
        api_url: api_url.to_owned(),
        user_id: user.user_id.clone(),
        username: user.username.clone(),
    });
    state.config.set_credential_profiles(profiles)?;
    state.config.set_active_credential_profile_id(Some(id))?;
    for account in replaced_accounts {
        let _ = state.credentials.delete_account(&account);
    }
    Ok(())
}

fn profile_id(api_url: &str, user_id: &str) -> String {
    format!("api={api_url}; user={user_id}")
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
    let user = state.api.get_user_info(&api_key).await?;
    save_profile(&state, &api_url, &user, &api_key)?;
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
    game::patch_install(&state.resources, &win64_path)?;
    state.config.set_game_path(win64_path)?;
    let user = state.api.get_user_info(&api_key).await?;
    save_profile(&state, &state.api.base_url(), &user, &api_key)?;
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
    let Some(api_key) = active_api_key(state)? else {
        return Ok(LauncherState {
            route: LauncherRoute::Login,
            registration_mode: None,
        });
    };
    match state.api.get_user_info(&api_key).await {
        Ok(user) => {
            let api_url = state.api.base_url();
            save_profile(state, &api_url, &user, &api_key)?;
            state_for_valid_user(state).await
        }
        Err(error) if error.code == "invalid_credentials" => Ok(LauncherState {
            route: LauncherRoute::Login,
            registration_mode: None,
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
    active_api_key(state)?.ok_or_else(CommandError::invalid_credentials)
}

fn active_api_key(state: &AppState) -> Result<Option<String>, CommandError> {
    if let Some(profile_id) = state.config.active_credential_profile_id()?
        && let Some(key) = state.credentials.get_account(&profile_id)?
    {
        return Ok(Some(key));
    }
    state.credentials.get()
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
