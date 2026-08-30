use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LauncherRoute {
    Login,
    Install,
    Play,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RegistrationMode {
    #[serde(rename = "NONE")]
    None,
    #[serde(rename = "INVITECODE")]
    InviteCode,
    #[serde(rename = "OPEN")]
    Open,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteCode {
    pub invite_code: String,
    pub uses_remaining: u64,
    pub infinite_uses: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminState {
    pub registration_mode: RegistrationMode,
    pub invite_codes: Vec<InviteCode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherState {
    pub route: LauncherRoute,
    pub registration_mode: Option<RegistrationMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialProfile {
    pub id: String,
    pub api_url: String,
    pub user_id: String,
    pub username: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialBootstrap {
    pub api_url: String,
    pub profiles: Vec<CredentialProfile>,
    pub active_profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationResult {
    pub api_key: String,
    pub next_route: LauncherRoute,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub username: String,
    pub version: String,
    pub online_players: u64,
    pub game_running: bool,
    pub is_admin: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundAsset {
    pub path: String,
    pub media_type: String,
}
