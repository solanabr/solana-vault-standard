# SVS Proof Backend

ZK proof generation backend for SVS-2 Confidential Vaults. Generates Token-2022 Confidential Transfer proofs using `solana-zk-sdk`.

## Why This Exists

Token-2022's Confidential Transfers require ZK proofs for operations like:
- **ConfigureAccount**: Proving ownership of an ElGamal keypair
- **Withdraw/Redeem**: Proving encrypted balance contains sufficient funds
- **Transfer**: Proving amount validity without revealing values

These proofs require elliptic curve operations on curve25519 (Ristretto) that cannot be performed in JavaScript. The official WASM bindings for `solana-zk-sdk` are expected mid-2026.

This backend bridges the gap by exposing proof generation as REST API endpoints.

## Quick Start

```bash
# Development
cargo run

# Production (Docker)
docker compose up -d

# With API keys (recommended for production)
API_KEYS=your-secret-key-1,your-secret-key-2 docker compose up -d
```

## API Endpoints

### Health Check

```
GET /health
```

Response:
```json
{
  "status": "healthy",
  "version": "0.1.0",
  "timestamp": 1706500000
}
```

### Generate PubkeyValidityProof

```
POST /api/proofs/pubkey-validity
```

Required for `ConfigureAccount` instruction.

Request:
```json
{
  "wallet_pubkey": "base58...",
  "token_account": "base58...",
  "timestamp": 1706500000,
  "request_signature": "base64...",
  "elgamal_signature": "base64..."
}
```

Response:
```json
{
  "proof_data": "base64...",
  "elgamal_pubkey": "base64..."
}
```

### Generate EqualityProof

```
POST /api/proofs/equality
```

Required for `Withdraw` and `Redeem` instructions.

Request:
```json
{
  "wallet_pubkey": "base58...",
  "token_account": "base58...",
  "timestamp": 1706500000,
  "request_signature": "base64...",
  "elgamal_signature": "base64...",
  "current_ciphertext": "base64...",
  "amount": "1000000000"
}
```

Response:
```json
{
  "proof_data": "base64..."
}
```

### Generate RangeProof

```
POST /api/proofs/range
```

Required for batched withdraw/transfer operations.

Request:
```json
{
  "wallet_pubkey": "base58...",
  "timestamp": 1706500000,
  "request_signature": "base64...",
  "amounts": ["1000000000", "500000000"],
  "commitment_blindings": ["base64...", "base64..."]
}
```

Response:
```json
{
  "proof_data": "base64..."
}
```

## Authentication

### Dual-Layer Security

1. **API Key** (optional in dev, required in production)
   - Set via `API_KEYS` environment variable
   - Pass via `X-API-Key` header

2. **Wallet Signature Verification**
   - Every request includes a signed message proving wallet ownership
   - Message format: `"SVS_PROOF_REQUEST" || timestamp (8 bytes LE) || token_account (32 bytes)`
   - Timestamp must be within 5 minutes (configurable)

### Signature Requirements

**Request Signature** (`request_signature`):
```
sign("SVS_PROOF_REQUEST" || timestamp_le_bytes || token_account_bytes)
```

**ElGamal Derivation Signature** (`elgamal_signature`):
```
sign("ElGamalSecretKey" || token_account_bytes)
```

This matches the standard derivation used by `spl-token` CLI.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | 3001 | Server port |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated allowed origins |
| `API_KEYS` | (none) | Comma-separated API keys |
| `TIMESTAMP_TOLERANCE_SECS` | 300 | Max age of request timestamp |
| `RUST_LOG` | `info` | Log level |

## SDK Integration

The `@stbr/svs-privacy-sdk` provides functions to call this backend:

```typescript
import {
  configureProofBackend,
  createPubkeyValidityProofViaBackend,
  isProofBackendAvailable,
} from "@stbr/svs-privacy-sdk";

// Configure backend (call once at startup)
configureProofBackend("https://proofs.example.com", "your-api-key");

// Check availability
if (await isProofBackendAvailable()) {
  // Generate proof
  const { proofData, elgamalPubkey } = await createPubkeyValidityProofViaBackend(
    wallet,
    tokenAccount
  );
}
```

## Docker Deployment

```bash
# Build image
docker build -t svs-proof-backend .

# Run with docker-compose
docker compose up -d

# View logs
docker compose logs -f
```

### docker-compose.yml

```yaml
services:
  proof-backend:
    build: .
    ports:
      - "3001:3001"
    environment:
      - RUST_LOG=info
      - PORT=3001
      - CORS_ORIGINS=https://app.example.com
      - API_KEYS=${API_KEYS}
    restart: unless-stopped
```

## Security Considerations

| Concern | Mitigation |
|---------|------------|
| Unauthorized access | API key required in production |
| Request forgery | Wallet signature verification |
| Replay attacks | Timestamp within 5 min window |
| Large payloads | 64KB request body limit |
| Key leakage | Keys never stored or logged |

## Development

```bash
# Run tests
cargo test

# Run with debug logging
RUST_LOG=debug cargo run

# Format code
cargo fmt

# Lint
cargo clippy
```

## Architecture

```
backend/
├── src/
│   ├── main.rs              # Server entry, middleware
│   ├── error.rs             # Error types
│   ├── types.rs             # Request/response types
│   ├── routes/
│   │   ├── health.rs        # Health endpoint
│   │   └── proofs.rs        # Proof generation endpoints
│   └── services/
│       └── proof_generator.rs  # ZK proof generation
├── Cargo.toml
├── Dockerfile
└── docker-compose.yml
```

## License

Apache 2.0
