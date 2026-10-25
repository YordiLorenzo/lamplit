// Lamplit's one error type. Commands hand it to the page as { kind, message }: `message` is what the player reads,
// `kind` is "player" for a message written for the player, "internal" for one written for the log, or else the
// library that failed.

use serde::ser::{Serialize, SerializeStruct, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A message written for the player, shown as it is.
    #[error("{0}")]
    Player(String),
    /// What went wrong inside Lamplit, written for the log (often as part of a longer line).
    #[error("{0}")]
    Internal(String),
    #[error(transparent)]
    Windows(#[from] windows::core::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    WebSocket(#[from] tungstenite::Error),
    #[error(transparent)]
    Hid(#[from] hidapi::HidError),
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    fn kind(&self) -> &'static str {
        match self {
            Error::Player(_) => "player",
            Error::Internal(_) => "internal",
            Error::Windows(_) => "windows",
            Error::Io(_) => "io",
            Error::Json(_) => "json",
            Error::WebSocket(_) => "websocket",
            Error::Hid(_) => "hid",
            Error::Tauri(_) => "tauri",
        }
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut error = serializer.serialize_struct("Error", 2)?;
        error.serialize_field("kind", self.kind())?;
        error.serialize_field("message", &self.to_string())?;
        error.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reaches_the_page_as_kind_and_message() {
        let player = Error::Player("The headset didn't answer.".into());
        assert_eq!(serde_json::to_value(&player).unwrap(), ipc_fixture!("error"));
        let internal = Error::Internal("no answer".into());
        assert_eq!(serde_json::to_value(&internal).unwrap(), json!({ "kind": "internal", "message": "no answer" }));
        let io = Error::from(std::io::Error::new(std::io::ErrorKind::NotFound, "no such file"));
        assert_eq!(serde_json::to_value(&io).unwrap(), json!({ "kind": "io", "message": "no such file" }));
    }
}
