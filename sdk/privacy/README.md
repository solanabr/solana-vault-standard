# @stbr/svs-privacy-sdk

Privacy SDK for SVS-3/SVS-4 Confidential Vaults. Provides ElGamal/AES encryption, ZK proof structures, and Token-2022 Confidential Transfer integration.

## Installation

```bash
npm install @stbr/svs-privacy-sdk
```

## Requirements

- SVS-3 or SVS-4 program deployed
- [Proofs Backend](https://github.com/solanabr/tokenized-vault-standard/tree/main/proofs-backend) running for ZK proof generation

## Quick Start

```typescript
import {
  deriveElGamalKeypair,
  deriveAesKey,
  encryptDecryptableBalance,
  generateProofData,
  ProofType
} from "@stbr/svs-privacy-sdk";

// Derive encryption keys from wallet
const elGamalKeypair = deriveElGamalKeypair(wallet.secretKey);
const aesKey = deriveAesKey(wallet.secretKey);

// Encrypt balance for on-chain storage
const encryptedBalance = encryptDecryptableBalance(balance, aesKey);

// Generate ZK proof for confidential transfer
const proofData = await generateProofData(ProofType.Range, {
  amount: 1000000n,
  keypair: elGamalKeypair,
});
```

## Features

- **ElGamal Encryption** - Public key encryption for share balances
- **AES-128-GCM** - Symmetric encryption for decryptable balances
- **ZK Proof Structures** - PubkeyValidity, Equality, Range proofs
- **Proof Backend Integration** - REST API client for proof generation

## Documentation

See [Privacy Documentation](https://github.com/solanabr/tokenized-vault-standard/blob/main/docs/PRIVACY.md).

## License

Apache 2.0
