use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl CommandError {
    pub fn new(code: impl Into<String>, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("internal", message, false)
    }

    pub fn invalid_credentials() -> Self {
        Self::new(
            "invalid_credentials",
            "That User API Key is not valid.",
            false,
        )
    }

    pub fn api_unavailable() -> Self {
        Self::new(
            "api_unavailable",
            "The Undaunted service is unavailable. Check your connection and try again.",
            true,
        )
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CommandError {}
