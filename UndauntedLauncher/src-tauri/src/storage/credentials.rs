use crate::error::CommandError;

const SERVICE: &str = "com.stayundaunted.launcher";
const ACCOUNT: &str = "default";

pub struct Credentials;

impl Credentials {
    fn entry() -> Result<keyring::Entry, CommandError> {
        keyring::Entry::new(SERVICE, ACCOUNT)
            .map_err(|_| CommandError::internal("The secure credential store is unavailable."))
    }

    pub fn get(&self) -> Result<Option<String>, CommandError> {
        match Self::entry()?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(CommandError::internal(
                "The saved API key could not be read.",
            )),
        }
    }

    pub fn set(&self, value: &str) -> Result<(), CommandError> {
        Self::entry()?
            .set_password(value)
            .map_err(|_| CommandError::internal("The API key could not be saved."))
    }

    pub fn delete(&self) -> Result<(), CommandError> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(CommandError::internal(
                "The saved API key could not be removed.",
            )),
        }
    }
}
