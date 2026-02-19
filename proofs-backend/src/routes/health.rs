//! Health check endpoint

use axum::{routing::get, Json, Router};
use chrono::Utc;

use crate::types::HealthResponse;

/// Create health check router
pub fn health_router() -> Router {
    Router::new().route("/health", get(health_check))
}

/// Health check handler
async fn health_check() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "healthy".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        timestamp: Utc::now().timestamp(),
    })
}
