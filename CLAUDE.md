# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Native ERC-4626 port to Solana. Tokenized vaults where shares represent proportional ownership of underlying SPL tokens. Four variants across two dimensions (live/stored balance × public/confidential shares).

**Stack**: Anchor 0.31+, Rust 1.82+, Token-2022, TypeScript, web3.js v1

## Build & Test Commands

```bash
# Build
anchor build                                    # all programs
anchor build -p svs-1 -- --features modules     # single program with modules

# Format & Lint
cargo fmt --all
cargo clippy --all-targets                      # Anchor derive macro warnings are expected

# Test
anchor test                                     # all integration tests (256 tests)
anchor test -- tests/svs-1.ts                   # single test file
anchor test -- --grep "deposit"                 # filter by pattern
anchor test --skip-build                        # skip rebuild
yarn test:modules                               # module integration tests
yarn test:sdk                                   # SDK unit tests (460 tests)
cargo test --workspace                          # Rust unit tests

# SDK
cd sdk/core && yarn build && yarn test

# Fuzz
cd trident-tests && trident fuzz run-hfuzz

# Proofs backend (required for SVS-3/4 tests)
cd proofs-backend && cargo run --release &      # localhost:3000
```

## Architecture

### Vault Variant Matrix

|                  | Live Balance (reads `asset_vault.amount`) | Stored Balance (caches `vault.total_assets`, needs `sync()`) |
|------------------|------------------------------------------|--------------------------------------------------------------|
| **Public**       | SVS-1                                     | SVS-2                                                        |
| **Confidential** | SVS-3 (Token-2022 CT + ElGamal)          | SVS-4                                                        |

All variants implement the same core interface: `initialize`, `deposit`, `mint`, `withdraw`, `redeem` + view functions (`preview_*`, `convert_to_*`, `max_*`, `total_assets`).

### Core Math (svs-math)

Virtual offset prevents inflation attacks: `offset = 10^(9 - asset_decimals)`
```
shares = assets × (total_shares + offset) / (total_assets + offset)
```

Rounding always favors the vault:
- `deposit`/`redeem` → Floor (user gets less)
- `mint`/`withdraw` → Ceiling (user pays more)

### Module System

Modules are standalone Rust crates (no Anchor dep), wired via `--features modules`. Passed as `remaining_accounts` for backward compatibility. Currently integrated in SVS-1 only.

| Module | Purpose |
|--------|---------|
| svs-math | Shared conversions/rounding (built-in, not a hook) |
| svs-fees | Entry/exit/management/performance fees |
| svs-caps | Global and per-user deposit caps |
| svs-locks | Time-locked shares (max 1 year) |
| svs-access | Whitelist/blacklist with merkle proofs |
| svs-rewards | Secondary reward distribution (scaffolding) |
| svs-oracle | Price validation (scaffolding) |

### Key PDA Seeds

- **Vault**: `["vault", asset_mint, vault_id.to_le_bytes()]`
- **Shares Mint**: `["shares", vault_pubkey]`
- **Module configs**: `["<module_name>", vault.key()]`

### SDK Class Hierarchy

`SolanaVault` (SVS-1 base) → `ManagedVault` (SVS-2, adds `sync()`). Confidential helpers in `sdk/privacy/`.

### Program Layout (each `programs/svs-N/src/`)

`lib.rs` (thin wrappers) → `instructions/` (one file per handler) → `state.rs`, `error.rs`, `events.rs`, `constants.rs`, `math.rs` (wrapper around svs-math).

### Instruction Handler Pattern (7 steps)

1. Validate (constraints, signer, state)
2. Read state (assets, shares, balances)
3. Compute (conversion math, fees)
4. Slippage check (user min/max bounds)
5. Execute CPIs (token transfers/mints/burns)
6. Update state (stored-balance variants only)
7. Emit event

## Skills & Commands

Run `/quick-commit`, `/build-program`, `/test-rust`, `/test-ts`, `/deploy`, `/audit-solana` for workflows.
Agents: `solana-architect`, `anchor-engineer`, `solana-qa-engineer`, `tech-docs-writer`, `solana-guide`, `solana-researcher`
Details in `.claude/commands/`, `.claude/agents/`, `.claude/skills/`

## Standards

- Branch before work: `git checkout -b <type>/<scope>-<description>`
- Build → Format → Lint → Test before commit
- Conventional Commits: `feat(svs-1): add deposit cap enforcement`
- Devnet first, mainnet only with explicit confirmation
- Round in favor of the vault (protect existing shareholders)
- Update `CHANGELOG.md` for user-facing changes

## Anti-Patterns (Growing List)

**Security - NEVER:**
- `unwrap()` in program code
- Unchecked arithmetic - use `checked_add`, `checked_sub`
- Recalculate PDA bumps - store canonical bumps
- Skip account validation (owner, signer, PDA derivation)
- Deploy mainnet without explicit user confirmation
- Trust CPI return data without validating target program ID

**Code Quality - NEVER:**
- Comments stating the obvious (`// increment counter` before `counter += 1`)
- Defensive try/catch blocks abnormal for the codebase
- Verbose error messages where simple ones suffice
- Import unused dependencies
- Create abstractions for one-time operations
- Add features beyond what was asked

**AI Slop - ALWAYS REMOVE:**
- Excessive inline comments on self-explanatory code
- Redundant validation of already-validated data
- Style inconsistent with surrounding code
- Empty error handling blocks
- `// TODO: implement` without actual implementation plan

**Vault-Specific - NEVER:**
- Allow share price manipulation via direct token transfers
- Skip virtual shares/assets offset (inflation attack vector)
- Round in favor of user over vault on entry/exit

## Lessons Learned

<!-- Add entries as issues arise -->

**2026-03: Confidential Transfer context state accounts**
- Range proof data exceeds single tx size - split into 2 txs
- Context state account must be created before CT withdraw instruction

**2026-02: Token-2022 transfer hooks**
- Extra accounts must be resolved before CPI, not during
- Use `get_extra_account_metas_address` for hook state PDA

## Review Checklist

Before merge, run `git diff main...HEAD` and verify:
- No AI slop introduced
- Error handling matches existing patterns
- No unnecessary abstractions added
- Security checks present where needed
