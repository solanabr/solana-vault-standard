# SVS Privacy Guide

## Privacy Levels

| Level | What's Hidden | Programs | Requirements |
|-------|--------------|----------|--------------|
| None | Nothing | SVS-1, SVS-2 | None |
| Amount | Share balances | SVS-3, SVS-4 | Proof backend |
| Full | Addresses + amounts | SVS-3/4 + Privacy Cash | Proof backend + Privacy Cash |

## How Confidential Transfers Work

Share balances are encrypted using ElGamal encryption on the curve25519/Ristretto group.
Only the owner (with private key) can decrypt.

## Proof Backend

The solana-zk-sdk library has no JavaScript/WASM bindings, so a Rust backend is required for ZK proof generation.

### Backend Endpoints

| Endpoint | Proof Type | Use Case |
|----------|------------|----------|
| POST /api/proofs/pubkey-validity | PubkeyValidityProof | ConfigureAccount |
| POST /api/proofs/equality | CiphertextCommitmentEqualityProof | Withdraw, Redeem |
| POST /api/proofs/range | BatchedRangeProofU64 | Batched operations |
| POST /api/proofs/withdraw | Equality + Range (shared Pedersen opening) | Withdraw, Redeem (combined) |

## Balance Models in Private Vaults

### SVS-3 (Live Balance)
- Reads `asset_vault.amount` directly for all calculations
- Share price reflects real-time vault balance
- No sync needed — yield is immediate
- `total_assets` field unused on-chain (always 0)
- Proof context accounts validated via owner check (`account.owner == zk_elgamal_proof_program::id()`)

### SVS-4 (Stored Balance)
- Reads `vault.total_assets` from state
- Requires `sync()` to recognize external deposits
- Authority controls yield distribution timing
- Same proof requirements as SVS-3

## Privacy Limitations

**Hidden:** Share balances, transfer amounts
**NOT Hidden:** Transaction graph, deposit/withdrawal amounts, account existence

For full privacy, combine SVS-3/4 with Privacy Cash for address unlinkability.
