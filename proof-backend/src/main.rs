//! SVS Proof Backend
//!
//! ZK proof generation backend for SVS-2 Confidential Vaults.
//! Provides REST API endpoints for generating Token-2022 Confidential Transfer proofs.

mod error;
mod routes;
mod services;
mod types;

use axum::{
    body::Body,
    extract::Request,
    http::{header, HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::Response,
    Router,
};
use std::sync::Arc;
use tower_http::{
    cors::CorsLayer,
    limit::RequestBodyLimitLayer,
    trace::TraceLayer,
};
use tracing::{info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use routes::{health_router, proofs_router};
use types::Config;

#[tokio::main]
async fn main() {
    // Initialize tracing
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "svs_proof_backend=info,tower_http=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Load configuration
    let config = Arc::new(Config::from_env());

    info!(port = config.port, "Starting SVS Proof Backend");
    info!(
        cors_origins = ?config.cors_origins,
        api_keys_configured = !config.api_keys.is_empty(),
        "Configuration loaded"
    );

    // Build CORS layer
    let cors = build_cors_layer(&config);

    // Build the router
    let app = Router::new()
        .merge(health_router())
        .merge(proofs_router(config.clone()))
        .layer(middleware::from_fn_with_state(
            config.clone(),
            api_key_middleware,
        ))
        .layer(cors)
        .layer(RequestBodyLimitLayer::new(64 * 1024)) // 64KB max request body
        .layer(TraceLayer::new_for_http());

    // Start server
    let addr = format!("0.0.0.0:{}", config.port);
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();

    info!(address = %addr, "Server listening");

    axum::serve(listener, app).await.unwrap();
}

/// Build CORS layer from config
fn build_cors_layer(config: &Config) -> CorsLayer {
    let origins: Vec<_> = config
        .cors_origins
        .iter()
        .filter_map(|s| s.parse().ok())
        .collect();

    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION, header::HeaderName::from_static("x-api-key")])
}

/// API key authentication middleware
async fn api_key_middleware(
    axum::extract::State(config): axum::extract::State<Arc<Config>>,
    headers: HeaderMap,
    request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    // Skip auth for health check
    if request.uri().path() == "/health" {
        return Ok(next.run(request).await);
    }

    // If no API keys configured, allow all requests (development mode)
    if config.api_keys.is_empty() {
        warn!("No API keys configured - running in development mode");
        return Ok(next.run(request).await);
    }

    // Check for API key header
    let api_key = headers
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            warn!("Request missing API key");
            StatusCode::UNAUTHORIZED
        })?;

    // Validate API key (don't log the actual key for security)
    if !config.api_keys.contains(&api_key.to_string()) {
        warn!("Invalid API key provided");
        return Err(StatusCode::UNAUTHORIZED);
    }

    Ok(next.run(request).await)
}
