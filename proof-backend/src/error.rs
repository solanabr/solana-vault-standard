//! Error types for the SVS Proof Backend

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use thiserror::Error;

/// Backend error types
#[derive(Debug, Error)]
pub enum BackendError {
    #[error("Invalid request: {0}")]
    BadRequest(String),

    #[error("Proof generation failed: {0}")]
    ProofGeneration(String),

    #[error("Invalid signature: {0}")]
    InvalidSignature(String),

    #[error("Invalid public key: {0}")]
    InvalidPubkey(String),

    #[error("Request expired: timestamp too old")]
    RequestExpired,

    #[error("Internal error: {0}")]
    Internal(String),
}

/// Error response body
#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
    pub code: String,
}

impl IntoResponse for BackendError {
    fn into_response(self) -> Response {
        let (status, code) = match &self {
            BackendError::BadRequest(_) => (StatusCode::BAD_REQUEST, "BAD_REQUEST"),
            BackendError::ProofGeneration(_) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "PROOF_GENERATION_FAILED")
            }
            BackendError::InvalidSignature(_) => (StatusCode::BAD_REQUEST, "INVALID_SIGNATURE"),
            BackendError::InvalidPubkey(_) => (StatusCode::BAD_REQUEST, "INVALID_PUBKEY"),
            BackendError::RequestExpired => (StatusCode::BAD_REQUEST, "REQUEST_EXPIRED"),
            BackendError::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR"),
        };

        let body = Json(ErrorResponse {
            error: self.to_string(),
            code: code.to_string(),
        });

        (status, body).into_response()
    }
}

impl From<anyhow::Error> for BackendError {
    fn from(err: anyhow::Error) -> Self {
        BackendError::Internal(err.to_string())
    }
}

/// Result type alias for backend operations
pub type Result<T> = std::result::Result<T, BackendError>;
