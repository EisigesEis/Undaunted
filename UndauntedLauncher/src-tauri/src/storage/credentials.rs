use crate::error::CommandError;

const SERVICE: &str = "com.stayundaunted.launcher";
pub struct Credentials;

pub const LEGACY_ACCOUNT: &str = "default";

impl Credentials {
    fn entry(account: &str) -> Result<keyring::Entry, CommandError> {
        keyring::Entry::new(SERVICE, account)
            .map_err(|_| CommandError::internal("The secure credential store is unavailable."))
    }

    pub fn get(&self) -> Result<Option<String>, CommandError> {
        self.get_account(LEGACY_ACCOUNT)
    }

    pub fn get_account(&self, account: &str) -> Result<Option<String>, CommandError> {
        match Self::entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(CommandError::internal(
                "The saved API key could not be read.",
            )),
        }
    }

    pub fn set(&self, value: &str) -> Result<(), CommandError> {
        self.set_account(LEGACY_ACCOUNT, value)
    }

    pub fn set_account(&self, account: &str, value: &str) -> Result<(), CommandError> {
        Self::entry(account)?
            .set_password(value)
            .map_err(|_| CommandError::internal("The API key could not be saved."))
    }

    pub fn delete(&self) -> Result<(), CommandError> {
        self.delete_account(LEGACY_ACCOUNT)
    }

    pub fn delete_account(&self, account: &str) -> Result<(), CommandError> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(CommandError::internal(
                "The saved API key could not be removed.",
            )),
        }
    }
}
