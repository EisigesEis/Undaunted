use reqwest::{Method, StatusCode};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::json;

use crate::{
    error::CommandError,
    launcher::models::{InviteCode, RegistrationMode},
};

pub const DEFAULT_API_URL: &str = "http://api.stayundaunted.com";

pub fn normalize_http_url(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.contains("://") {
        trimmed.trim_end_matches('/').to_owned()
    } else {
        format!("http://{}", trimmed.trim_end_matches('/'))
    }
}

pub struct ApiClient {
    http: reqwest::Client,
    base_url: std::sync::RwLock<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct UserInfo {
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub is_admin: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RegistrationModeResponse {
    registration_mode: RegistrationMode,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct PublicOnlineStatsResponse {
    num_active_players: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
struct RegistrationResponse {
    uuk: String,
}

#[derive(Debug, Deserialize)]
struct VersionResponse {
    en: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct InviteCodesResponse {
    invite_codes: Vec<InviteCode>,
}

impl ApiClient {
    pub fn from_runtime(api_url: Option<String>) -> Result<Self, CommandError> {
        let user_agent = format!("UndauntedLauncher/{}", env!("CARGO_PKG_VERSION"));
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30))
            .user_agent(&user_agent)
            .build()
            .map_err(|_| {
                CommandError::internal("The launcher HTTP client could not be created.")
            })?;
        Ok(Self {
            http,
            base_url: std::sync::RwLock::new(normalize_http_url(
                api_url.as_deref().unwrap_or(DEFAULT_API_URL),
            )),
        })
    }

    pub fn set_api_url(&self, value: &str) {
        *self.base_url.write().unwrap() = normalize_http_url(value);
    }
    pub fn base_url(&self) -> String {
        self.base_url.read().unwrap().clone()
    }

    pub async fn get_user_info(&self, api_key: &str) -> Result<UserInfo, CommandError> {
        let user: UserInfo = self
            .request(
                Method::GET,
                "/undaunted/api/GetUserInfo",
                Some(api_key),
                None,
            )
            .await?;
        if user.user_id.trim().is_empty() {
            return Err(CommandError::invalid_credentials());
        }
        Ok(user)
    }

    pub async fn get_registration_mode(&self) -> Result<RegistrationMode, CommandError> {
        let response: RegistrationModeResponse = self
            .request(Method::GET, "/undaunted/api/RegistrationStatus", None, None)
            .await?;
        Ok(response.registration_mode)
    }

    pub async fn register(
        &self,
        username: &str,
        invite_code: Option<&str>,
    ) -> Result<String, CommandError> {
        let response: RegistrationResponse = self
            .request(
                Method::POST,
                "/undaunted/api/Register",
                None,
                Some(json!({
                    "Username": username,
                    "InviteCode": invite_code,
                })),
            )
            .await?;

        if response.uuk.trim().is_empty() {
            return Err(CommandError::new(
                "registration_failed",
                "Registration did not return a User API Key.",
                false,
            ));
        }

        Ok(response.uuk)
    }

    pub async fn get_online_players(&self, api_key: &str) -> Result<u64, CommandError> {
        let response: PublicOnlineStatsResponse = self
            .request(
                Method::GET,
                "/undaunted/api/PublicOnlineStats",
                Some(api_key),
                None,
            )
            .await?;
        Ok(response.num_active_players)
    }

    pub async fn get_version(&self, api_key: &str) -> Result<String, CommandError> {
        let response: VersionResponse = self
            .request(Method::GET, "/dauntless-status", Some(api_key), None)
            .await?;
        let version = display_version(&response.en);
        if version.is_empty() {
            return Err(CommandError::new(
                "malformed_response",
                "The game version response was empty.",
                true,
            ));
        }
        Ok(version)
    }

    pub async fn get_invite_codes(&self, api_key: &str) -> Result<Vec<InviteCode>, CommandError> {
        let response: InviteCodesResponse = self
            .request(
                Method::GET,
                "/undaunted/api/InviteCodes",
                Some(api_key),
                None,
            )
            .await?;
        Ok(response.invite_codes)
    }

    pub async fn set_registration_mode(
        &self,
        api_key: &str,
        mode: RegistrationMode,
    ) -> Result<(), CommandError> {
        self.request_empty(
            Method::POST,
            "/undaunted/api/RegistrationStatus",
            api_key,
            Some(json!({ "RegistrationStatus": mode })),
        )
        .await
    }

    pub async fn create_invite_code(
        &self,
        api_key: &str,
        code: &str,
        uses: u64,
        infinite: bool,
    ) -> Result<(), CommandError> {
        self.request_empty(
            Method::POST,
            "/undaunted/api/RegisterInviteCode",
            api_key,
            Some(json!({ "NewInviteCode": code, "Uses": uses, "InfiniteUses": infinite })),
        )
        .await
    }

    pub async fn delete_invite_code(&self, api_key: &str, code: &str) -> Result<(), CommandError> {
        let encoded: String = url::form_urlencoded::byte_serialize(code.as_bytes()).collect();
        self.request_empty(
            Method::DELETE,
            &format!("/undaunted/api/InviteCode/{encoded}"),
            api_key,
            None,
        )
        .await
    }

    async fn request_empty(
        &self,
        method: Method,
        path: &str,
        api_key: &str,
        body: Option<serde_json::Value>,
    ) -> Result<(), CommandError> {
        let mut request = self
            .http
            .request(method, format!("{}{}", self.base_url.read().unwrap(), path))
            .header("x-undaunted-user-api-key", api_key);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|_| CommandError::api_unavailable())?;
        self.check_status(response.status())
    }

    fn check_status(&self, status: StatusCode) -> Result<(), CommandError> {
        if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
            return Err(CommandError::invalid_credentials());
        }
        if !status.is_success() {
            return Err(CommandError::new(
                "server_error",
                format!("The Undaunted service returned HTTP {status}."),
                status.is_server_error(),
            ));
        }
        Ok(())
    }

    async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        api_key: Option<&str>,
        body: Option<serde_json::Value>,
    ) -> Result<T, CommandError> {
        let mut request = self
            .http
            .request(method, format!("{}{}", self.base_url.read().unwrap(), path));

        if let Some(api_key) = api_key {
            request = request.header("x-undaunted-user-api-key", api_key);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }

        let response = request
            .send()
            .await
            .map_err(|_| CommandError::api_unavailable())?;
        let status = response.status();

        self.check_status(status)?;

        response.json().await.map_err(|_| {
            CommandError::new(
                "malformed_response",
                "The Undaunted service returned an invalid response.",
                true,
            )
        })
    }
}

fn display_version(value: &str) -> String {
    let message = value.trim().trim_matches('"').trim();
    message
        .strip_prefix("Welcome to ")
        .unwrap_or(message)
        .strip_suffix('!')
        .unwrap_or_else(|| message.strip_prefix("Welcome to ").unwrap_or(message))
        .trim()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::{display_version, normalize_http_url};

    #[test]
    fn normalizes_api_urls() {
        assert_eq!(
            normalize_http_url("api.example.test/"),
            "http://api.example.test"
        );
        assert_eq!(
            normalize_http_url("http://127.0.0.1:60000/"),
            "http://127.0.0.1:60000"
        );
    }

    #[test]
    fn extracts_dashboard_version() {
        assert_eq!(
            display_version("Welcome to Undaunted v0.0.6!"),
            "Undaunted v0.0.6"
        );
        assert_eq!(display_version("Undaunted v0.0.6"), "Undaunted v0.0.6");
    }
}
