# SVS-2 Privacy Architecture

This document details the privacy mechanisms in SVS-2 and the current implementation status.

## Overview

SVS-2 provides privacy-preserving tokenized vaults using Token-2022's Confidential Transfers extension. Share balances are encrypted using twisted ElGamal encryption, and operations are verified using zero-knowledge proofs.

## Privacy Levels

| Level | Components | What's Hidden | Trust Model |
|-------|------------|---------------|-------------|
| **Public** | SVS-1 | Nothing | Transparent |
| **Amount Privacy** | SVS-2 | Share balances | Encryption keys |
| **Full Privacy** | SVS-2 + Privacy Cash | Amounts + addresses | Encryption + mixing |

## Cryptographic Primitives

### ElGamal Encryption (Balance Privacy)

Share balances are encrypted using twisted ElGamal encryption over curve25519:

```
Ciphertext = (C, D)
Where:
  C = v·H + r·G  (Pedersen commitment to value v)
  D = r·P        (Decryption handle using pubkey P)
```

**Properties:**
- **Additively homomorphic**: Balances can be updated without decryption
- **Provable**: Zero-knowledge proofs verify operations without revealing values
- **32-byte pubkey**: Compressed Ristretto point

### AES-128-GCM (Owner Decryption)

Alongside ElGamal ciphertexts, the program stores AES-encrypted "decryptable balances":

```
DecryptableBalance = nonce (12) || ciphertext (8) || tag (16) = 36 bytes
```

This allows owners to efficiently decrypt their balance without brute-forcing the ElGamal ciphertext (which would require O(2^64) work for large balances).

### Zero-Knowledge Proofs

| Proof Type | Purpose | Size |
|------------|---------|------|
| **PubkeyValidity** | Proves knowledge of ElGamal secret key | 64 bytes |
| **CiphertextCommitmentEquality** | Proves ciphertext encrypts same value as commitment | 192 bytes |
| **BatchedRangeProofU64** | Proves values are in range [0, 2^64) | 672+ bytes |

## Key Derivation

Keys are derived deterministically from the wallet signature, following Token-2022 standards:

### ElGamal Keypair

```typescript
// Seed: "ElGamalSecretKey" || tokenAccount
const message = Buffer.concat([
  Buffer.from("ElGamalSecretKey"),
  tokenAccount.toBuffer()
]);
const signature = wallet.signMessage(message);
const keypair = ElGamalKeypair.newFromSigner(signature);
```

### AES Key

```typescript
// Seed: "AeKey" || tokenAccount
const message = Buffer.concat([
  Buffer.from("AeKey"),
  tokenAccount.toBuffer()
]);
const signature = wallet.signMessage(message);
const aesKey = AeKey.newFromSigner(signature);
```

## Instruction Flow

### 1. Initialize Vault (Authority)

Creates vault with ConfidentialTransferMint extension:

```
initialize
├── Create shares mint (Token-2022)
├── Initialize ConfidentialTransferMint extension
│   ├── authority: vault PDA
│   ├── auto_approve_new_accounts: true
│   └── auditor_elgamal_pubkey: optional
└── Emit VaultInitialized event
```

### 2. Configure Account (User)

Enables confidential transfers on user's shares account:

```
configure_account
├── User derives ElGamal keypair
├── User derives AES key
├── User creates PubkeyValidityProof (ZK)
├── Submit proof to ZK ElGamal program
└── Call Token-2022 ConfigureAccount
    ├── elgamal_pubkey: 32 bytes
    ├── decryptable_zero_balance: 36 bytes (AES encrypted 0)
    └── proof_instruction_offset: -1 (previous instruction)
```

### 3. Deposit (User)

Deposits assets, mints encrypted shares:

```
deposit
├── Transfer assets to vault
├── Calculate shares amount
├── Mint shares to user's PENDING balance (encrypted)
└── User must call apply_pending to move to available
```

### 4. Apply Pending Balance (User)

Moves pending balance to available balance:

```
apply_pending
├── User computes new decryptable_available_balance
├── Submit ApplyPendingBalance instruction
└── Pending balance added to available (homomorphic)
```

### 5. Withdraw/Redeem (User)

Burns encrypted shares, receives assets:

```
withdraw/redeem
├── User creates CiphertextCommitmentEqualityProof
├── User creates BatchedRangeProofU64
├── Submit proofs to ZK ElGamal program
├── Call Token-2022 confidential burn
├── Transfer assets to user
└── Update decryptable_available_balance
```

## ZK ElGamal Proof Program

The ZK ElGamal Proof program (`ZkE1Gama1Proof11111111111111111111111111111`) is a native Solana program that verifies zero-knowledge proofs.

### Instruction Discriminators (Agave 3.0+)

| Discriminator | Instruction |
|---------------|-------------|
| 0 | CloseContextState |
| 1 | VerifyZeroCiphertext |
| 2 | VerifyCiphertextCiphertextEquality |
| 3 | VerifyCiphertextCommitmentEquality |
| 4 | VerifyPubkeyValidity |
| 5 | VerifyPercentageWithCap |
| 6 | VerifyBatchedRangeProofU64 |
| 7 | VerifyBatchedRangeProofU128 |
| 8 | VerifyBatchedRangeProofU256 |
| 9+ | (Additional validity proofs) |

### Proof Submission

Proofs can be submitted in two ways:

1. **InstructionOffset**: Proof in same transaction, referenced by offset
2. **ContextStateAccount**: Pre-verified proof stored in account

## Current Implementation Status

### ✅ Implemented and Working

| Component | Status | Notes |
|-----------|--------|-------|
| SVS-2 Program | ✅ | Full instruction set |
| ConfidentialTransferMint setup | ✅ | Vault initialization |
| Key derivation (JS) | ✅ | ElGamal + AES |
| AES encryption/decryption | ✅ | Web Crypto API |
| Instruction builders | ✅ | Correct formats |
| ZK discriminators | ✅ | Agave 3.0 compatible |
| Test coverage | ✅ | 97 tests passing |

### ❌ Blocked by WASM Bindings

| Component | Status | Required For |
|-----------|--------|--------------|
| PubkeyValidityProof generation | ❌ | ConfigureAccount |
| EqualityProof generation | ❌ | Withdraw/Redeem |
| RangeProof generation | ❌ | Withdraw/Redeem |
| CiphertextValidityProof generation | ❌ | Transfer |

### Why WASM is Required

The ZK proofs require cryptographic operations on curve25519 (Ristretto) that cannot be efficiently implemented in pure JavaScript:

1. **Schnorr sigma protocols**: Require scalar multiplication on Ristretto
2. **Pedersen commitments**: Require two-base scalar multiplication
3. **Bulletproofs**: Require inner product arguments over Ristretto

The `solana-zk-sdk` Rust crate provides these operations, but JavaScript bindings are not yet available.

### Timeline

| Milestone | Expected |
|-----------|----------|
| Rust SDK available | ✅ Now |
| CLI tools (spl-token) | ✅ Now |
| WASM bindings | Mid-2026 |
| Native wallet support | Late 2026 |

## Workarounds

### 1. Rust Backend Proxy

Run a backend service that generates proofs:

```rust
// Backend endpoint: POST /api/proofs/pubkey-validity
pub async fn generate_pubkey_validity_proof(
    wallet_signature: &[u8],
    token_account: Pubkey,
) -> Result<Vec<u8>> {
    let elgamal_keypair = ElGamalKeypair::new_from_signer(wallet_signature, &token_account)?;
    let proof_data = PubkeyValidityProofData::new(&elgamal_keypair)?;
    Ok(proof_data.to_bytes())
}
```

```typescript
// Frontend calls backend for proof
const proofBytes = await fetch('/api/proofs/pubkey-validity', {
  method: 'POST',
  body: JSON.stringify({ signature, tokenAccount }),
}).then(r => r.arrayBuffer());
```

### 2. CLI Wrapper

Use `spl-token` CLI which has built-in proof generation:

```bash
spl-token configure-confidential-transfer-account \
  --program-2022 \
  <TOKEN_MINT>
```

### 3. Wallet-as-a-Service

Some providers support confidential transfers and handle proof generation server-side.

## Privacy Cash Integration

For full address privacy, combine SVS-2 with Privacy Cash:

```
User → Shield Assets → Privacy Cash Pool → Ephemeral Wallet → SVS-2 Deposit
                              ↑
                    Address link broken
```

### Flow

1. User deposits assets into Privacy Cash (shielded pool)
2. User generates ephemeral wallet
3. User withdraws from Privacy Cash to ephemeral wallet
4. Ephemeral wallet deposits into SVS-2 vault
5. Original address is now unlinked from vault position

## Auditor Support

SVS-2 supports optional auditor ElGamal pubkeys for compliance:

```rust
pub struct ConfidentialVault {
    // ...
    pub auditor_elgamal_pubkey: Option<[u8; 32]>,
}
```

When set, the auditor can decrypt all balances in the vault using their secret key, enabling regulatory compliance while preserving privacy from the public.

## Security Considerations

### Encryption Key Management

- ElGamal and AES keys are derived from wallet signatures
- Keys are specific to each token account
- Compromised wallet = compromised encryption keys

### Proof Security

- Proofs are verified by the ZK ElGamal native program
- Invalid proofs fail verification (cannot forge)
- Proofs do not reveal values (zero-knowledge)

### Decryptable Balance

- AES-encrypted balance stored alongside ElGamal ciphertext
- Allows efficient owner decryption
- Must be updated correctly on each operation

### Pending vs Available Balance

- Deposits go to pending balance first
- User must explicitly apply pending to available
- Prevents reentrancy-style attacks

## References

- [Token-2022 Confidential Transfers](https://solana.com/docs/tokens/extensions/confidential-transfer)
- [ZK ElGamal Proof Program](https://docs.anza.xyz/runtime/zk-elgamal-proof)
- [solana-zk-sdk](https://docs.rs/solana-zk-sdk)
- [Twisted ElGamal Paper](https://iacr.org/archive/asiacrypt2004/33290377/33290377.pdf)
- [Bulletproofs](https://eprint.iacr.org/2017/1066.pdf)
