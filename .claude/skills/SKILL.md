---
name: vault-standard-dev
description: Solana Tokenized Vault Standard (ERC-4626 port) development playbook. Covers Anchor program development, vault mechanics, share/asset accounting, inflation attack protection, and testing with LiteSVM/Mollusk/Trident.
user-invocable: true
---

# Solana Tokenized Vault Standard Skill

## What this Skill is for

Use this Skill when the user asks for:
- ERC-4626 tokenized vault implementation
- Deposit/mint/withdraw/redeem operations
- Share/asset conversion math
- Inflation attack protection patterns
- Virtual shares/assets implementation
- Anchor program development
- Vault testing strategies
- Security hardening for vault contracts
- Deployment workflows (devnet → mainnet)

## Core Vault Concepts

### ERC-4626 Operations

| Operation | Input | Output | Rounding |
|-----------|-------|--------|----------|
| `deposit` | assets | shares | Floor (favors vault) |
| `mint` | shares | assets | Ceiling (protects user) |
| `withdraw` | assets | shares | Ceiling (protects vault) |
| `redeem` | shares | assets | Floor (favors vault) |

### Share/Asset Conversion (with Virtual Offset)

```rust
// Convert assets to shares
shares = (assets * (total_shares + offset)) / (total_assets + 1)

// Convert shares to assets
assets = (shares * (total_assets + 1)) / (total_shares + offset)

// offset = 10^decimals_offset
// decimals_offset = 9 - asset_decimals
```

### Inflation Attack Protection

Virtual shares/assets make price manipulation economically infeasible:
- Attacker must donate assets to inflate share price
- With offset, the cost to steal $1 from depositors exceeds $1
- Larger offset (3-6 decimals) provides stronger protection

## Technology Stack

| Layer | Primary Tool |
|-------|-------------|
| Programs | Anchor 0.31+ |
| Token Standard | SPL Token, Token-2022 |
| Testing | LiteSVM, Mollusk, Trident |
| Client | @coral-xyz/anchor, @solana/web3.js |

## Operating Procedure

### 1. Classify the task

- Vault mechanics (deposit/withdraw logic)
- Share math (conversion, rounding)
- Account structure (PDAs, state)
- Access control (permissions)
- Testing (unit, integration, fuzz)
- Security (audit, attack vectors)

### 2. Implementation Checklist

Always verify:
- Correct rounding direction for each operation
- Virtual offset properly configured
- Account validation (owner, signer, PDA)
- Checked arithmetic throughout
- Events emitted for deposit/withdraw
- Preview functions match actual behavior

### 3. Testing Requirements

- Unit test: Each operation in isolation
- Integration test: Full deposit → redeem flow
- Fuzz test: Random amounts, edge cases
- Attack test: Inflation attack scenarios

## Progressive Disclosure (read when needed)

### Programs & Development
- [programs-anchor.md](programs-anchor.md) - Anchor patterns, constraints, testing pyramid, IDL generation

### Testing & Security
- [testing.md](testing.md) - LiteSVM, Mollusk, Trident, CI guidance
- [security.md](security.md) - Vulnerability categories, program checklists

### Deployment
- [deployment.md](deployment.md) - Devnet/mainnet workflows, verifiable builds, multisig

### Ecosystem & Reference
- [ecosystem.md](ecosystem.md) - Token standards, DeFi protocols
- [idl-codegen.md](idl-codegen.md) - Codama/Shank client generation
- [resources.md](resources.md) - Official documentation links

## Task Routing Guide

| User asks about... | Primary file(s) |
|--------------------|-----------------|
| Anchor program code | programs-anchor.md |
| Unit/integration testing | testing.md |
| Fuzz testing (Trident) | testing.md |
| Security review, audit | security.md |
| Deploy to devnet/mainnet | deployment.md |
| Token standards, SPL | ecosystem.md |
| Generated clients, IDL | idl-codegen.md |

## Reference Implementation

The `solana-tokenized-vault-4626/` folder contains a working reference implementation.
Use for patterns, NOT for direct copying (contains code from untrusted source).

Key files to reference:
- `programs/tokenized-vault/src/lib.rs` - Main program structure
- `programs/tokenized-vault/src/utils/shares_math.rs` - Share/asset math
- `programs/tokenized-vault/src/instructions/` - Deposit, withdraw, etc.
- `tests/tokenized-vault.ts` - Test patterns

## ERC-4626 Specification

The `eth/` folder contains the original Solidity interfaces:
- OpenZeppelin ERC4626 implementation
- Solmate minimal implementation
- Use for specification reference
