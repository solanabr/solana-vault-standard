# Solana Vault Standard (SVS)

ERC-4626 equivalent for Solana - standardized tokenized vault interfaces with optional privacy.

## SVS Roadmap

| Version | Name | Privacy | Backend Required | Status |
|---------|------|---------|------------------|--------|
| **SVS-1** | Public Vault | None | No | Production-ready |
| **SVS-2** | Confidential Vault | Encrypted balances | Yes (Rust backend) | Beta |
| **SVS-3** | Native Confidential | Encrypted balances | No (WASM) | Planned (mid-2026) |
| **SVS-4+** | Privacy Stack Variants | Full unlinkability | Varies | Planned |

### SVS-1: Simple Public Vault

Standard tokenized vault with visible balances. Deposits assets, mints proportional share tokens, redeems shares for assets. All balances visible on-chain. Production-ready implementation of ERC-4626 on Solana.

### SVS-2: Confidential Vault with Backend Proxy

The first privacy-preserving vault implementation. Uses a three-layer stack:

1. **Token-2022 Confidential Transfers Extension** - ElGamal encryption for share balances
2. **Privacy Cash Integration** - Shielded pool for address unlinkability
3. **Rust Proof Backend** - Server-side ZK proof generation

**Why a backend?** Token-2022's Confidential Transfers require ZK proofs (PubkeyValidityProof, EqualityProof, RangeProof) that use elliptic curve operations on curve25519 (Ristretto). These cannot be performed in JavaScript - the `solana-zk-sdk` has no WASM bindings (expected mid-2026). The Rust backend bridges this gap by exposing proof generation as REST endpoints.

```
┌─────────────────┐     ┌────────────────────┐     ┌─────────────────┐
│   JS Frontend   │────▶│  Rust Proof Backend│────▶│  Solana Network │
│  (Privacy SDK)  │     │  (solana-zk-sdk)   │     │  (ZK ElGamal)   │
└─────────────────┘     └────────────────────┘     └─────────────────┘
        │                        │
        │ 1. Sign message        │ 2. Generate ZK proof
        │ 2. Request proof       │    (curve25519/Ristretto)
        │ 3. Get proof bytes     │
        └────────────────────────┘
```

### SVS-3: Native Confidential (Planned)

Once `solana-zk-sdk` WASM bindings ship (expected mid-2026), SVS-3 will provide the same confidential vault functionality entirely client-side. No backend required - all proof generation happens in the browser/wallet.

### SVS-4+: Privacy Stack Variations (Planned)

Future variants may include:
- Stealth addresses for recipient privacy
- Distros with Cloak.xyz integrated
- Cross-chain private bridges
- etc

---

## Program IDs

| Program | ID |
|---------|-----|
| SVS-1 | `SVS1VauLt1111111111111111111111111111111111` |
| SVS-2 | `SVS2VauLt2222222222222222222222222222222222` |

## Three-Tier Privacy Architecture

| Level | Program | SDK | What's Hidden |
|-------|---------|-----|---------------|
| **None** | SVS-1 | `@stbr/svs-sdk` | Nothing |
| **Amount** | SVS-2 | `@stbr/svs-privacy-sdk` | Share balances (encrypted) |
| **Full** | SVS-2 + Privacy Cash | `@stbr/svs-privacy-sdk` | Addresses + amounts |

## Installation

```bash
# Core SDK (SVS-1)
npm install @stbr/svs-sdk

# Privacy SDK (SVS-2 + Privacy Cash)
npm install @stbr/svs-privacy-sdk

# Backend (for SVS-2 proof generation)
cd proof-backend && cargo run
```

---

# SVS-1: Public Vault

Standard tokenized vault with visible balances.

## Features

| Feature | Description |
|---------|-------------|
| **ERC-4626 Compatible** | Standard interface matching Ethereum's vault standard |
| **Inflation Attack Protection** | Virtual offset mechanism prevents donation attacks |
| **Vault-Favoring Rounding** | All operations round to protect vault solvency |
| **Slippage Protection** | Min/max parameters prevent sandwich attacks |
| **Multi-Vault Support** | Multiple vaults per asset via `vault_id` |
| **Emergency Controls** | Pause/unpause and authority transfer |
| **CPI-Composable Views** | Preview functions callable from other programs |

## Quick Start

```typescript
import { SolanaVault } from "@stbr/svs-sdk";

// Initialize vault wrapper
const vault = new SolanaVault(program, vaultPda);

// Deposit assets
const shares = await vault.deposit(assets, minSharesOut);

// Redeem shares
const assetsReceived = await vault.redeem(shares, minAssetsOut);

// Preview operations
const expectedShares = await vault.previewDeposit(assets);
```

## Core Operations

| Operation | User Action | Rounding | Favors |
|-----------|-------------|----------|--------|
| **deposit** | Pay exact assets -> receive shares | Floor | Vault |
| **mint** | Receive exact shares -> pay assets | Ceiling | Vault |
| **withdraw** | Receive exact assets -> burn shares | Ceiling | Vault |
| **redeem** | Burn exact shares -> receive assets | Floor | Vault |

---

# SVS-2: Confidential Vault

Privacy-preserving vault with encrypted share balances.

## Features

All SVS-1 features plus:

| Feature | Description |
|---------|-------------|
| **Encrypted Balances** | Share balances encrypted with ElGamal |
| **Owner Decryption** | Only owner can decrypt their balance (AES-GCM) |
| **Optional Auditor** | Compliance-friendly auditor key support |
| **ZK Proof Verification** | Native ZK ElGamal Proof program integration |
| **Privacy Cash Ready** | Full address unlinkability with Privacy Cash |

## How It Works

1. **Vault Creation**: Shares mint initialized with ConfidentialTransferMint extension
2. **Account Setup**: Users configure their account with ElGamal keypair (requires backend proof)
3. **Deposits**: Assets deposited, shares minted to encrypted pending balance
4. **Apply Pending**: User moves pending balance to available (encrypted)
5. **Withdrawals**: User proves balance ownership via ZK proofs (requires backend), receives assets

## SDK Usage with Backend

```typescript
import {
  configureProofBackend,
  createPubkeyValidityProofViaBackend,
  isProofBackendAvailable,
} from "@stbr/svs-privacy-sdk";

// Configure backend URL (call once at startup)
configureProofBackend("http://localhost:3001", "your-api-key");

// Check backend availability
if (await isProofBackendAvailable()) {
  // Generate PubkeyValidityProof for ConfigureAccount
  const { proofData, elgamalPubkey } = await createPubkeyValidityProofViaBackend(
    wallet,
    tokenAccount
  );

  // Use proof in instruction
  const configureIx = createConfigureAccountInstruction(
    tokenAccount,
    mint,
    owner,
    elgamalPubkey,
    proofData,
  );
}
```

## Proof Backend Setup

The Rust backend generates ZK proofs for Token-2022 Confidential Transfers.

```bash
# Development
cd proof-backend && cargo run

# Production (Docker)
cd proof-backend && docker compose up -d

# With API keys
API_KEYS=your-secret-key docker compose up -d
```

See [proof-backend/README.md](proof-backend/README.md) for full API documentation.

### Backend Endpoints

| Endpoint | Proof Type | Required For |
|----------|------------|--------------|
| `POST /api/proofs/pubkey-validity` | PubkeyValidityProof | ConfigureAccount |
| `POST /api/proofs/equality` | CiphertextCommitmentEqualityProof | Withdraw, Redeem |
| `POST /api/proofs/range` | BatchedRangeProofU64 | Batched operations |

### Security Model

| Layer | Purpose |
|-------|---------|
| API Key | Prevents unauthorized access |
| Wallet Signature | Proves request authenticity |
| Timestamp | Prevents replay attacks (5 min window) |
| Request Limit | 64KB body size limit |

## Feature Availability

| Feature | JS SDK Only | With Backend |
|---------|-------------|--------------|
| Key derivation (ElGamal, AES) | Works | Works |
| Instruction builders | Works | Works |
| Confidential deposits | Works | Works |
| ConfigureAccount | Blocked | Works |
| Withdraw / Redeem | Blocked | Works |
| Transfer | Blocked | Works |
| ApplyPendingBalance | Partial | Works |

## Full Privacy with Privacy Cash

For complete address unlinkability, combine SVS-2 with Privacy Cash:

```typescript
import { PrivacySolanaVault } from "@stbr/svs-privacy-sdk";

const vault = new PrivacySolanaVault(connection, vaultPda);

// Private deposit: shields assets, breaks address link, deposits to vault
await vault.privateDeposit({
  assets: 1000_000000,
  wallet,
});

// Private withdraw: reverse flow
await vault.privateWithdraw({
  shares: 500_000000000,
  wallet,
});
```

---

## Architecture

```
+--------------------------------------------------------------------+
|                    Solana Vault Standard                           |
+--------------------------------------------------------------------+
|                                                                    |
|   SVS-1 (Public)              SVS-2 (Confidential)                 |
|   +------------------+        +------------------+                 |
|   | Vault Account    |        | Confidential     |                 |
|   | - authority      |        | Vault Account    |                 |
|   | - asset_mint     |        | - authority      |                 |
|   | - shares_mint    |        | - asset_mint     |                 |
|   | - total_assets   |        | - shares_mint    |<-- Token-2022   |
|   +--------+---------+        |   + CT Mint Ext  |    + CT Ext     |
|            |                  | - auditor_key    |                 |
|            v                  +--------+---------+                 |
|   +------------------+                 |                           |
|   |  User Shares     |                 v                           |
|   |  (public u64)    |        +------------------+                 |
|   +------------------+        |  User Shares     |                 |
|                               |  (encrypted)     |                 |
|                               |  - pending       |<-- ElGamal      |
|                               |  - available     |                 |
|                               |  - decryptable   |<-- AES-GCM      |
|                               +------------------+                 |
|                                        |                           |
|                                        v                           |
|                               +------------------+                 |
|                               |  Proof Backend   |                 |
|                               |  (Rust/Axum)     |                 |
|                               +--------+---------+                 |
|                                        |                           |
|                                        v                           |
|                               +------------------+                 |
|                               |  ZK ElGamal      |                 |
|                               |  Proof Program   |                 |
|                               |  (Native)        |                 |
|                               +------------------+                 |
|                                                                    |
+--------------------------------------------------------------------+
```

## PDA Derivation

### Vault PDA
**Seeds:** `["vault", asset_mint, vault_id (u64 LE)]`

```typescript
const [vault] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault"), assetMint.toBuffer(), vaultId.toArrayLike(Buffer, "le", 8)],
  programId
);
```

### Shares Mint PDA
**Seeds:** `["shares", vault_pubkey]`

```typescript
const [sharesMint] = PublicKey.findProgramAddressSync(
  [Buffer.from("shares"), vault.toBuffer()],
  programId
);
```

## Instructions

### Core Operations (Both Programs)

| Instruction | Description |
|-------------|-------------|
| `initialize` | Create new vault |
| `deposit` | Deposit assets, receive shares |
| `mint` | Mint exact shares, pay assets |
| `withdraw` | Withdraw exact assets, burn shares |
| `redeem` | Burn shares, receive assets |

### Admin Operations (Both Programs)

| Instruction | Description |
|-------------|-------------|
| `pause` | Emergency pause vault |
| `unpause` | Resume operations |
| `transfer_authority` | Transfer admin rights |
| `sync` | Sync total_assets with balance |

### SVS-2 Only

| Instruction | Description |
|-------------|-------------|
| `configure_account` | Enable confidential mode on user account |
| `apply_pending` | Move pending balance to available |

## Error Codes

| Code | Name | Description |
|------|------|-------------|
| 6000 | ZeroAmount | Amount must be > 0 |
| 6001 | SlippageExceeded | Slippage tolerance exceeded |
| 6002 | VaultPaused | Vault is paused |
| 6003 | InvalidAssetDecimals | Asset decimals > 9 |
| 6004 | MathOverflow | Arithmetic overflow |
| 6005 | DivisionByZero | Division by zero |
| 6006 | InsufficientShares | Not enough shares |
| 6007 | InsufficientAssets | Not enough assets |
| 6008 | Unauthorized | Not vault authority |
| 6009 | DepositTooSmall | Below minimum deposit |
| 6010 | AccountNotConfigured | Account not configured for confidential transfers (SVS-2) |
| 6011 | PendingBalanceNotApplied | Pending balance not applied - call apply_pending first (SVS-2) |
| 6012 | InvalidProof | Invalid ZK proof data (SVS-2) |
| 6013 | ConfidentialTransferNotInitialized | CT extension not initialized (SVS-2) |
| 6014 | InvalidCiphertext | Invalid ciphertext format (SVS-2) |

## Events

| Event | Description |
|-------|-------------|
| `VaultInitialized` | New vault created |
| `Deposit` | Assets deposited |
| `Withdraw` | Assets withdrawn |
| `VaultSynced` | Total assets synced |
| `VaultStatusChanged` | Pause/unpause |
| `AuthorityTransferred` | Authority changed |

## Security

See [docs/SECURITY.md](docs/SECURITY.md) for detailed security information.

**Key Features:**
- Virtual offset inflation attack protection
- Vault-favoring rounding strategy
- Slippage protection on all operations
- Emergency pause mechanism
- Checked arithmetic throughout
- PDA bumps stored (not recalculated)

**Audit Status:** Not audited. Use at your own risk.

## Testing

```bash
# Build both programs
anchor build

# Run all tests (97 passing)
anchor test

# Run SVS-1 tests only
anchor test -- --grep "svs-1"

# Run SVS-2 tests only
anchor test -- --grep "svs-2"

# Backend tests
cd proof-backend && cargo test
```

## Project Structure

```
tokenized-vault-standard/
├── programs/
│   ├── svs-1/                    # Public vault program
│   └── svs-2/                    # Confidential vault program
├── sdk/
│   ├── core/                     # @stbr/svs-sdk
│   └── privacy/                  # @stbr/svs-privacy-sdk
│       ├── src/
│       │   ├── encryption.ts     # ElGamal/AES key derivation
│       │   ├── proofs.ts         # ZK proof + backend integration
│       │   ├── confidential-instructions.ts  # Token-2022 CT instructions
│       │   ├── privacy-cash.ts   # Privacy Cash integration
│       │   └── private-vault.ts  # Full privacy vault wrapper
│       └── package.json
├── proof-backend/                # Rust proof generation backend
│   ├── src/
│   │   ├── main.rs               # Axum server
│   │   ├── routes/proofs.rs      # Proof endpoints
│   │   └── services/proof_generator.rs  # ZK proof generation
│   ├── Cargo.toml
│   ├── Dockerfile
│   └── README.md
├── tests/
│   ├── svs-1.ts                  # Public vault tests
│   └── svs-2.ts                  # Confidential vault tests
└── docs/
    ├── ARCHITECTURE.md
    ├── SECURITY.md
    └── PRIVACY.md
```

## Resources

- [ERC-4626 Standard](https://eips.ethereum.org/EIPS/eip-4626)
- [ERC-4626 on Solana](https://solana.com/pt/developers/evm-to-svm/erc4626)
- [Token-2022 Confidential Transfers](https://solana.com/docs/tokens/extensions/confidential-transfer)
- [ZK ElGamal Proof Program](https://docs.anza.xyz/runtime/zk-elgamal-proof)
- [Anchor Documentation](https://www.anchor-lang.com/)

## License

Apache 2.0

## Disclaimer

This software is provided "as is" without warranty. Use at your own risk. Not audited. SVS-2 requires the Rust proof backend for full functionality until WASM bindings are available (expected mid-2026).