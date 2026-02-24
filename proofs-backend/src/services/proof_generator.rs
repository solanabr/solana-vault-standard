//! ZK Proof Generation Service
//!
//! Uses solana-zk-sdk to generate valid ZK proofs for Token-2022 Confidential Transfers.

use crate::error::{BackendError, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{SeedDerivable, Signature};
use solana_zk_sdk::encryption::{
    elgamal::{ElGamalCiphertext, ElGamalKeypair},
    pedersen::{Pedersen, PedersenOpening},
    pod::elgamal::PodElGamalCiphertext,
};
use solana_zk_sdk::zk_elgamal_proof_program::proof_data::{
    BatchedRangeProofU64Data, CiphertextCommitmentEqualityProofData, PubkeyValidityProofData,
};
use std::str::FromStr;

/// Combined proof data for CT withdraw/redeem
#[derive(Debug)]
pub struct WithdrawProofData {
    /// CiphertextCommitmentEqualityProof bytes
    pub equality_proof: Vec<u8>,
    /// BatchedRangeProofU64 bytes
    pub range_proof: Vec<u8>,
}

/// Proof generator service
pub struct ProofGenerator;

impl ProofGenerator {
    /// Derive ElGamal keypair from wallet signature
    ///
    /// The signature should be of the message: "ElGamalSecretKey" || token_account
    /// This matches the standard derivation used by spl-token CLI and wallets.
    pub fn derive_elgamal_keypair(
        elgamal_signature: &[u8; 64],
        token_account: &Pubkey,
    ) -> Result<ElGamalKeypair> {
        // The ElGamal keypair is derived by hashing the signature with the token account
        // This matches the derivation in solana-zk-sdk
        let seed = Self::derive_elgamal_seed(elgamal_signature, token_account);
        let keypair = ElGamalKeypair::from_seed(&seed)
            .map_err(|e| BackendError::ProofGeneration(format!("Failed to derive keypair: {e}")))?;
        Ok(keypair)
    }

    /// Derive ElGamal seed from signature and token account
    fn derive_elgamal_seed(signature: &[u8; 64], token_account: &Pubkey) -> [u8; 32] {
        use solana_sdk::hash::hashv;

        // Hash: signature || token_account
        let hash = hashv(&[signature, token_account.as_ref()]);
        hash.to_bytes()
    }

    /// Generate PubkeyValidityProof
    ///
    /// This proves that the ElGamal public key is correctly derived from the secret key.
    /// Required for ConfigureAccount instruction.
    pub fn generate_pubkey_validity_proof(
        elgamal_keypair: &ElGamalKeypair,
    ) -> Result<(Vec<u8>, [u8; 32])> {
        let proof_data = PubkeyValidityProofData::new(elgamal_keypair).map_err(|e| {
            BackendError::ProofGeneration(format!("Failed to generate pubkey validity proof: {e}"))
        })?;

        // Get the proof bytes using bytemuck
        let proof_bytes = bytemuck::bytes_of(&proof_data).to_vec();

        // Get the public key bytes
        let pubkey = elgamal_keypair.pubkey();
        let pubkey_bytes: [u8; 32] = pubkey.into();

        Ok((proof_bytes, pubkey_bytes))
    }

    /// Generate CiphertextCommitmentEqualityProof
    ///
    /// This proves that a ciphertext encrypts the same value as a Pedersen commitment.
    /// Required for Withdraw/Redeem instructions.
    pub fn generate_equality_proof(
        elgamal_keypair: &ElGamalKeypair,
        ciphertext: &ElGamalCiphertext,
        amount: u64,
    ) -> Result<Vec<u8>> {
        // Create a new Pedersen opening for the commitment
        let opening = PedersenOpening::new_rand();

        // Create the Pedersen commitment with the SAME opening
        // C = amount * H + opening * G
        let commitment = Pedersen::with(amount, &opening);

        let proof_data = CiphertextCommitmentEqualityProofData::new(
            elgamal_keypair,
            ciphertext,
            &commitment,
            &opening,
            amount,
        )
        .map_err(|e| {
            BackendError::ProofGeneration(format!("Failed to generate equality proof: {e}"))
        })?;

        Ok(bytemuck::bytes_of(&proof_data).to_vec())
    }

    /// Generate BatchedRangeProofU64
    ///
    /// This proves that multiple values are within the valid u64 range.
    /// Required for Withdraw/Redeem with multiple amounts.
    pub fn generate_range_proof(amounts: &[u64], openings: &[PedersenOpening]) -> Result<Vec<u8>> {
        if amounts.len() != openings.len() {
            return Err(BackendError::BadRequest(
                "Amounts and openings must have same length".to_string(),
            ));
        }

        // BatchedRangeProofU64Data expects specific batch sizes
        // We support 1, 2, 4, or 8 amounts
        let batch_size = amounts.len();
        if ![1, 2, 4, 8].contains(&batch_size) {
            return Err(BackendError::BadRequest(format!(
                "Batch size must be 1, 2, 4, or 8, got {batch_size}"
            )));
        }

        // Create commitments from amounts and openings using Pedersen::with
        let commitments: Vec<_> = amounts
            .iter()
            .zip(openings.iter())
            .map(|(amount, opening)| Pedersen::with(*amount, opening))
            .collect();

        // Create references for the API
        let commitment_refs: Vec<_> = commitments.iter().collect();
        let opening_refs: Vec<&PedersenOpening> = openings.iter().collect();

        // Bit lengths for u64 range proofs (64 bits each)
        let bit_lengths: Vec<usize> = vec![64; amounts.len()];

        let proof_data = BatchedRangeProofU64Data::new(
            commitment_refs,
            amounts.to_vec(),
            bit_lengths,
            opening_refs,
        )
        .map_err(|e| {
            BackendError::ProofGeneration(format!("Failed to generate range proof: {e}"))
        })?;

        Ok(bytemuck::bytes_of(&proof_data).to_vec())
    }

    /// Generate both proofs required for CT withdraw/redeem.
    ///
    /// Computes remaining_balance = current_balance - withdraw_amount, then generates:
    /// 1. CiphertextCommitmentEqualityProof (proves remaining ciphertext encrypts remaining amount)
    /// 2. BatchedRangeProofU64 (proves remaining balance is in [0, 2^64))
    ///
    /// Both proofs share the same Pedersen opening, which is required by Token-2022.
    pub fn generate_withdraw_proof(
        elgamal_keypair: &ElGamalKeypair,
        current_available_ciphertext: &ElGamalCiphertext,
        current_balance: u64,
        withdraw_amount: u64,
    ) -> Result<WithdrawProofData> {
        let remaining_balance = current_balance
            .checked_sub(withdraw_amount)
            .ok_or_else(|| {
                BackendError::BadRequest("Withdraw amount exceeds current balance".to_string())
            })?;

        // Compute remaining balance ciphertext via homomorphic subtraction
        let remaining_ciphertext = current_available_ciphertext.subtract_amount(withdraw_amount);

        // Generate Pedersen commitment for remaining balance (shared opening)
        let opening = PedersenOpening::new_rand();
        let commitment = Pedersen::with(remaining_balance, &opening);

        // Equality proof: proves remaining_ciphertext encrypts remaining_balance
        let equality_proof_data = CiphertextCommitmentEqualityProofData::new(
            elgamal_keypair,
            &remaining_ciphertext,
            &commitment,
            &opening,
            remaining_balance,
        )
        .map_err(|e| {
            BackendError::ProofGeneration(format!("Failed to generate equality proof: {e}"))
        })?;

        // Range proof: proves remaining_balance ∈ [0, 2^64)
        let range_proof_data = BatchedRangeProofU64Data::new(
            vec![&commitment],
            vec![remaining_balance],
            vec![64],
            vec![&opening],
        )
        .map_err(|e| {
            BackendError::ProofGeneration(format!("Failed to generate range proof: {e}"))
        })?;

        Ok(WithdrawProofData {
            equality_proof: bytemuck::bytes_of(&equality_proof_data).to_vec(),
            range_proof: bytemuck::bytes_of(&range_proof_data).to_vec(),
        })
    }

    /// Verify wallet request signature
    ///
    /// Verifies that the wallet signed the proof request message.
    pub fn verify_request_signature(
        wallet_pubkey: &Pubkey,
        timestamp: i64,
        token_account: &Pubkey,
        signature: &Signature,
    ) -> Result<()> {
        // Construct the expected message
        let message = Self::construct_request_message(timestamp, token_account);

        // Verify the signature
        if !signature.verify(wallet_pubkey.as_ref(), &message) {
            return Err(BackendError::InvalidSignature(
                "Request signature verification failed".to_string(),
            ));
        }

        Ok(())
    }

    /// Verify wallet request signature for range proof
    pub fn verify_range_request_signature(
        wallet_pubkey: &Pubkey,
        timestamp: i64,
        signature: &Signature,
    ) -> Result<()> {
        let message = Self::construct_range_request_message(timestamp);

        if !signature.verify(wallet_pubkey.as_ref(), &message) {
            return Err(BackendError::InvalidSignature(
                "Range request signature verification failed".to_string(),
            ));
        }

        Ok(())
    }

    /// Construct the message that should be signed for proof requests
    fn construct_request_message(timestamp: i64, token_account: &Pubkey) -> Vec<u8> {
        let mut message = b"SVS_PROOF_REQUEST".to_vec();
        message.extend_from_slice(&timestamp.to_le_bytes());
        message.extend_from_slice(token_account.as_ref());
        message
    }

    /// Construct the message for range proof requests
    fn construct_range_request_message(timestamp: i64) -> Vec<u8> {
        let mut message = b"SVS_PROOF_REQUEST".to_vec();
        message.extend_from_slice(&timestamp.to_le_bytes());
        message.extend_from_slice(b"range");
        message
    }

    /// Parse a base58 public key
    pub fn parse_pubkey(s: &str) -> Result<Pubkey> {
        Pubkey::from_str(s).map_err(|e| BackendError::InvalidPubkey(format!("Invalid pubkey: {e}")))
    }

    /// Parse a base64 signature
    pub fn parse_signature(s: &str) -> Result<Signature> {
        let bytes = STANDARD
            .decode(s)
            .map_err(|e| BackendError::InvalidSignature(format!("Invalid base64: {e}")))?;

        if bytes.len() != 64 {
            return Err(BackendError::InvalidSignature(format!(
                "Signature must be 64 bytes, got {}",
                bytes.len()
            )));
        }

        let mut sig_bytes = [0u8; 64];
        sig_bytes.copy_from_slice(&bytes);

        Ok(Signature::from(sig_bytes))
    }

    /// Parse base64-encoded ciphertext
    pub fn parse_ciphertext(s: &str) -> Result<ElGamalCiphertext> {
        let bytes = STANDARD
            .decode(s)
            .map_err(|e| BackendError::BadRequest(format!("Invalid ciphertext base64: {e}")))?;

        if bytes.len() != 64 {
            return Err(BackendError::BadRequest(format!(
                "Ciphertext must be 64 bytes, got {}",
                bytes.len()
            )));
        }

        // Convert bytes to PodElGamalCiphertext using bytemuck
        let pod_ciphertext: &PodElGamalCiphertext = bytemuck::try_from_bytes(&bytes)
            .map_err(|e| BackendError::BadRequest(format!("Invalid ciphertext bytes: {e}")))?;

        // Then convert to ElGamalCiphertext
        ElGamalCiphertext::try_from(*pod_ciphertext)
            .map_err(|e| BackendError::BadRequest(format!("Invalid ciphertext: {e}")))
    }

    /// Parse base64-encoded Pedersen opening
    pub fn parse_opening(s: &str) -> Result<PedersenOpening> {
        let bytes = STANDARD
            .decode(s)
            .map_err(|e| BackendError::BadRequest(format!("Invalid opening base64: {e}")))?;

        if bytes.len() != 32 {
            return Err(BackendError::BadRequest(format!(
                "Opening must be 32 bytes, got {}",
                bytes.len()
            )));
        }

        let mut opening_bytes = [0u8; 32];
        opening_bytes.copy_from_slice(&bytes);

        PedersenOpening::from_bytes(&opening_bytes)
            .ok_or_else(|| BackendError::BadRequest("Invalid Pedersen opening bytes".to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_request_message_construction() {
        let timestamp = 1706500000i64;
        let token_account = Pubkey::new_unique();

        let message = ProofGenerator::construct_request_message(timestamp, &token_account);

        assert!(message.starts_with(b"SVS_PROOF_REQUEST"));
        assert_eq!(message.len(), 17 + 8 + 32); // prefix + timestamp + pubkey
    }

    #[test]
    fn test_range_request_message_construction() {
        let timestamp = 1706500000i64;

        let message = ProofGenerator::construct_range_request_message(timestamp);

        assert!(message.starts_with(b"SVS_PROOF_REQUEST"));
        assert!(message.ends_with(b"range"));
        assert_eq!(message.len(), 17 + 8 + 5); // prefix + timestamp + "range"
    }

    #[test]
    fn test_elgamal_seed_derivation() {
        let signature = [1u8; 64];
        let token_account = Pubkey::new_unique();

        let seed = ProofGenerator::derive_elgamal_seed(&signature, &token_account);

        assert_eq!(seed.len(), 32);
    }

    #[test]
    fn test_elgamal_seed_deterministic() {
        let signature = [42u8; 64];
        let token_account = Pubkey::new_unique();

        let seed1 = ProofGenerator::derive_elgamal_seed(&signature, &token_account);
        let seed2 = ProofGenerator::derive_elgamal_seed(&signature, &token_account);

        assert_eq!(seed1, seed2);
    }

    #[test]
    fn test_elgamal_seed_different_for_different_inputs() {
        let signature1 = [1u8; 64];
        let signature2 = [2u8; 64];
        let token_account = Pubkey::new_unique();

        let seed1 = ProofGenerator::derive_elgamal_seed(&signature1, &token_account);
        let seed2 = ProofGenerator::derive_elgamal_seed(&signature2, &token_account);

        assert_ne!(seed1, seed2);
    }

    #[test]
    fn test_elgamal_keypair_derivation() {
        let signature = [42u8; 64];
        let token_account = Pubkey::new_unique();

        let keypair = ProofGenerator::derive_elgamal_keypair(&signature, &token_account);

        assert!(keypair.is_ok());
    }

    #[test]
    fn test_parse_pubkey_valid() {
        let pubkey = Pubkey::new_unique();
        let pubkey_str = pubkey.to_string();

        let parsed = ProofGenerator::parse_pubkey(&pubkey_str);

        assert!(parsed.is_ok());
        assert_eq!(parsed.unwrap(), pubkey);
    }

    #[test]
    fn test_parse_pubkey_invalid() {
        let result = ProofGenerator::parse_pubkey("invalid");

        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            BackendError::InvalidPubkey(_)
        ));
    }

    #[test]
    fn test_parse_signature_valid() {
        let sig_bytes = [0u8; 64];
        let sig_b64 = STANDARD.encode(sig_bytes);

        let parsed = ProofGenerator::parse_signature(&sig_b64);

        assert!(parsed.is_ok());
    }

    #[test]
    fn test_parse_signature_wrong_length() {
        let short_bytes = [0u8; 32];
        let sig_b64 = STANDARD.encode(short_bytes);

        let result = ProofGenerator::parse_signature(&sig_b64);

        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            BackendError::InvalidSignature(_)
        ));
    }

    #[test]
    fn test_parse_signature_invalid_base64() {
        let result = ProofGenerator::parse_signature("not-valid-base64!!!");

        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            BackendError::InvalidSignature(_)
        ));
    }

    #[test]
    fn test_parse_opening_valid() {
        let opening = PedersenOpening::new_rand();
        let opening_bytes = opening.to_bytes();
        let opening_b64 = STANDARD.encode(opening_bytes);

        let parsed = ProofGenerator::parse_opening(&opening_b64);

        assert!(parsed.is_ok());
    }

    #[test]
    fn test_parse_opening_wrong_length() {
        let short_bytes = [0u8; 16];
        let opening_b64 = STANDARD.encode(short_bytes);

        let result = ProofGenerator::parse_opening(&opening_b64);

        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), BackendError::BadRequest(_)));
    }

    #[test]
    fn test_pubkey_validity_proof_generation() {
        let signature = [42u8; 64];
        let token_account = Pubkey::new_unique();

        let keypair = ProofGenerator::derive_elgamal_keypair(&signature, &token_account).unwrap();
        let result = ProofGenerator::generate_pubkey_validity_proof(&keypair);

        assert!(result.is_ok());
        let (proof_data, pubkey_bytes) = result.unwrap();
        assert!(!proof_data.is_empty());
        assert_eq!(pubkey_bytes.len(), 32);
    }

    #[test]
    fn test_range_proof_invalid_batch_size() {
        let amounts = vec![100u64, 200, 300]; // 3 is not valid (must be 1, 2, 4, or 8)
        let openings: Vec<PedersenOpening> = (0..3).map(|_| PedersenOpening::new_rand()).collect();

        let result = ProofGenerator::generate_range_proof(&amounts, &openings);

        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), BackendError::BadRequest(_)));
    }

    #[test]
    fn test_range_proof_mismatched_lengths() {
        let amounts = vec![100u64, 200];
        let openings: Vec<PedersenOpening> = (0..4).map(|_| PedersenOpening::new_rand()).collect();

        let result = ProofGenerator::generate_range_proof(&amounts, &openings);

        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), BackendError::BadRequest(_)));
    }

    #[test]
    fn test_withdraw_proof_generation() {
        let signature = [42u8; 64];
        let token_account = Pubkey::new_unique();
        let keypair = ProofGenerator::derive_elgamal_keypair(&signature, &token_account).unwrap();

        // Encrypt a known balance
        let current_balance = 1_000_000u64;
        let ciphertext = keypair.pubkey().encrypt(current_balance);

        let result = ProofGenerator::generate_withdraw_proof(
            &keypair,
            &ciphertext,
            current_balance,
            500_000, // withdraw half
        );

        assert!(result.is_ok());
        let proof_data = result.unwrap();
        assert!(!proof_data.equality_proof.is_empty());
        assert!(!proof_data.range_proof.is_empty());
    }

    #[test]
    fn test_withdraw_proof_full_balance() {
        let signature = [42u8; 64];
        let token_account = Pubkey::new_unique();
        let keypair = ProofGenerator::derive_elgamal_keypair(&signature, &token_account).unwrap();

        let current_balance = 1_000_000u64;
        let ciphertext = keypair.pubkey().encrypt(current_balance);

        // Withdraw entire balance (remaining = 0)
        let result = ProofGenerator::generate_withdraw_proof(
            &keypair,
            &ciphertext,
            current_balance,
            current_balance,
        );

        assert!(result.is_ok());
    }

    #[test]
    fn test_withdraw_proof_exceeds_balance() {
        let signature = [42u8; 64];
        let token_account = Pubkey::new_unique();
        let keypair = ProofGenerator::derive_elgamal_keypair(&signature, &token_account).unwrap();

        let current_balance = 1_000_000u64;
        let ciphertext = keypair.pubkey().encrypt(current_balance);

        let result = ProofGenerator::generate_withdraw_proof(
            &keypair,
            &ciphertext,
            current_balance,
            current_balance + 1, // exceeds balance
        );

        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), BackendError::BadRequest(_)));
    }
}
