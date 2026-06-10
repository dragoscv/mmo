use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("audio device error: {0}")]
    Device(String),
    #[error("decode error: {0}")]
    Decode(String),
    #[error("engine not running")]
    NotRunning,
    #[error("invalid argument: {0}")]
    Invalid(String),
}
