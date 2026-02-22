//! Proof generation endpoints

use axum::{
    extract::State,
    routing::post,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Utc;
use std::sync::Arc;
use tracing::info;

use crate::{
    error::{BackendError, Result},
    services::ProofGenerator,
    types::{
        Config, EqualityProofRequest, EqualityProofResponse, PubkeyValidityRequest,
        PubkeyValidityResponse, RangeProofRequest, RangeProofResponse,
    },
};

/// Application state shared across handlers
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
}

/// Create proofs router
pub fn proofs_router(config: Arc<Config>) -> Router {
    let state = AppState { config };

    Router::new()
        .route("/api/proofs/pubkey-validity", post(pubkey_validity))
        .route("/api/proofs/equality", post(equality_proof))
        .route("/api/proofs/range", post(range_proof))
        .with_state(state)
}

/// Generate PubkeyValidityProof
///
/// POST /api/proofs/pubkey-validity
async fn pubkey_validity(
    State(state): State<AppState>,
    Json(req): Json<PubkeyValidityRequest>,
) -> Result<Json<PubkeyValidityResponse>> {
    info!(
        wallet = %req.wallet_pubkey,
        token_account = %req.token_account,
        "Generating pubkey validity proof"
    );

    // Validate timestamp
    validate_timestamp(req.timestamp, state.config.timestamp_tolerance_secs)?;

    // Parse inputs
    let wallet_pubkey = ProofGenerator::parse_pubkey(&req.wallet_pubkey)?;
    let token_account = ProofGenerator::parse_pubkey(&req.token_account)?;
    let request_signature = ProofGenerator::parse_signature(&req.request_signature)?;
    let elgamal_signature = ProofGenerator::parse_signature(&req.elgamal_signature)?;

    // Verify request signature
    ProofGenerator::verify_request_signature(
        &wallet_pubkey,
        req.timestamp,
        &token_account,
        &request_signature,
    )?;

    // Derive ElGamal keypair from the provided signature
    let sig_bytes: [u8; 64] = elgamal_signature.into();
    let elgamal_keypair = ProofGenerator::derive_elgamal_keypair(&sig_bytes, &token_account)?;

    // Generate the proof
    let (proof_data, elgamal_pubkey) =
        ProofGenerator::generate_pubkey_validity_proof(&elgamal_keypair)?;

    info!(
        proof_size = proof_data.len(),
        "Generated pubkey validity proof"
    );

    Ok(Json(PubkeyValidityResponse {
        proof_data: STANDARD.encode(&proof_data),
        elgamal_pubkey: STANDARD.encode(elgamal_pubkey),
    }))
}

/// Generate CiphertextCommitmentEqualityProof
///
/// POST /api/proofs/equality
async fn equality_proof(
    State(state): State<AppState>,
    Json(req): Json<EqualityProofRequest>,
) -> Result<Json<EqualityProofResponse>> {
    info!(
        wallet = %req.wallet_pubkey,
        token_account = %req.token_account,
        amount = %req.amount,
        "Generating equality proof"
    );

    // Validate timestamp
    validate_timestamp(req.timestamp, state.config.timestamp_tolerance_secs)?;

    // Parse inputs
    let wallet_pubkey = ProofGenerator::parse_pubkey(&req.wallet_pubkey)?;
    let token_account = ProofGenerator::parse_pubkey(&req.token_account)?;
    let request_signature = ProofGenerator::parse_signature(&req.request_signature)?;
    let elgamal_signature = ProofGenerator::parse_signature(&req.elgamal_signature)?;
    let ciphertext = ProofGenerator::parse_ciphertext(&req.current_ciphertext)?;
    let amount: u64 = req
        .amount
        .parse()
        .map_err(|e| BackendError::BadRequest(format!("Invalid amount: {e}")))?;

    // Verify request signature
    ProofGenerator::verify_request_signature(
        &wallet_pubkey,
        req.timestamp,
        &token_account,
        &request_signature,
    )?;

    // Derive ElGamal keypair
    let sig_bytes: [u8; 64] = elgamal_signature.into();
    let elgamal_keypair = ProofGenerator::derive_elgamal_keypair(&sig_bytes, &token_account)?;

    // Generate the proof
    let proof_data =
        ProofGenerator::generate_equality_proof(&elgamal_keypair, &ciphertext, amount)?;

    info!(proof_size = proof_data.len(), "Generated equality proof");

    Ok(Json(EqualityProofResponse {
        proof_data: STANDARD.encode(&proof_data),
    }))
}

/// Generate BatchedRangeProofU64
///
/// POST /api/proofs/range
async fn range_proof(
    State(state): State<AppState>,
    Json(req): Json<RangeProofRequest>,
) -> Result<Json<RangeProofResponse>> {
    info!(
        wallet = %req.wallet_pubkey,
        batch_size = req.amounts.len(),
        "Generating range proof"
    );

    // Validate timestamp
    validate_timestamp(req.timestamp, state.config.timestamp_tolerance_secs)?;

    // Parse inputs
    let wallet_pubkey = ProofGenerator::parse_pubkey(&req.wallet_pubkey)?;
    let request_signature = ProofGenerator::parse_signature(&req.request_signature)?;

    // Verify request signature
    ProofGenerator::verify_range_request_signature(
        &wallet_pubkey,
        req.timestamp,
        &request_signature,
    )?;

    // Parse amounts
    let amounts: Vec<u64> = req
        .amounts
        .iter()
        .map(|s| {
            s.parse()
                .map_err(|e| BackendError::BadRequest(format!("Invalid amount: {e}")))
        })
        .collect::<Result<Vec<_>>>()?;

    // Parse openings
    let openings: Vec<_> = req
        .commitment_blindings
        .iter()
        .map(|s| ProofGenerator::parse_opening(s))
        .collect::<Result<Vec<_>>>()?;

    // Generate the proof
    let proof_data = ProofGenerator::generate_range_proof(&amounts, &openings)?;

    info!(proof_size = proof_data.len(), "Generated range proof");

    Ok(Json(RangeProofResponse {
        proof_data: STANDARD.encode(&proof_data),
    }))
}

/// Validate that timestamp is within tolerance
fn validate_timestamp(timestamp: i64, tolerance_secs: i64) -> Result<()> {
    let now = Utc::now().timestamp();
    let diff = (now - timestamp).abs();

    if diff > tolerance_secs {
        return Err(BackendError::RequestExpired);
    }

    Ok(())
}
