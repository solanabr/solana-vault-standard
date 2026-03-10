# Contributing to Solana Vault Standard (SVS)

Thank you for your interest in contributing. This guide covers everything you need to get started, whether you're fixing a bug, adding a module, or proposing a new vault standard.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Implementing a New SVS Standard](#implementing-a-new-svs-standard)
- [Implementing a New Module](#implementing-a-new-module)
- [SDK and CLI Expansion](#sdk-and-cli-expansion)
- [Testing](#testing)
- [Code Standards](#code-standards)
- [Security Rules](#security-rules)
- [Pull Request Process](#pull-request-process)

## Prerequisites

- Rust 1.82+
- Anchor 0.31+
- Solana CLI 2.1+
- Node.js 20+ (22+ recommended)
- Yarn

## Getting Started

```bash
git clone https://github.com/solanabr/solana-vault-standard.git
cd solana-vault-standard
yarn install
anchor build
anchor test
```

For SVS-3 and SVS-4 (confidential transfer vaults), you also need the proof generation backend:

```bash
cd proofs-backend
cargo build --release
cargo run --release &   # runs on localhost:3000
cd ..
anchor test             # now includes SVS-3/4 tests
```

## Project Structure

```
programs/
  svs-1/          # Public vault, live balance (simplest)
  svs-2/          # Public vault, stored balance (requires sync())
  svs-3/          # Confidential vault, live balance (Token-2022 CT)
  svs-4/          # Confidential vault, stored balance (Token-2022 CT + sync)
modules/
  svs-math/       # Shared math: mul_div, rounding, conversions
  svs-fees/       # Entry/exit fee calculation
  svs-caps/       # Global and per-user deposit caps
  svs-locks/      # Time-locked shares
  svs-access/     # Whitelist/blacklist + merkle proofs
  svs-rewards/    # Secondary reward distribution (scaffolding)
  svs-oracle/     # Oracle price validation (scaffolding)
sdk/
  core/           # @stbr/solana-vault - TypeScript SDK + CLI
  privacy/        # @stbr/svs-privacy-sdk - confidential transfer helpers
tests/            # Integration tests (Anchor/Mocha)
docs/             # Specifications, architecture, guides
proofs-backend/   # Rust/Axum server for ZK proof generation (SVS-3/4)
trident-tests/    # Fuzz and invariant tests
scripts/          # Utility and test scripts
```

### How SVS Variants Work

SVS defines a matrix of vault types across two dimensions:

|                    | Live Balance        | Stored Balance        |
|--------------------|---------------------|-----------------------|
| **Public**         | SVS-1               | SVS-2                 |
| **Confidential**   | SVS-3               | SVS-4                 |

- **Live balance**: reads `asset_vault.amount` directly each instruction. External deposits are immediately reflected.
- **Stored balance**: caches `vault.total_assets` on-chain. Requires `sync()` to recognize external deposits. Gives the authority control over when yield is recognized.
- **Public**: standard Token-2022 shares, all balances visible on-chain.
- **Confidential**: Token-2022 with Confidential Transfer extension. Share balances are encrypted (ElGamal) and require ZK proofs.

All variants implement the same core interface (deposit, mint, withdraw, redeem) mapped from ERC-4626.

### Module Compatibility

Modules are currently wired into **SVS-1 only** via feature flags. They are designed as standalone Rust crates with no Anchor dependency so they can be integrated into any variant. When implementing a new SVS standard, you should wire in module support for all applicable modules.

| Module | SVS-1 | SVS-2 | SVS-3 | SVS-4 | Notes |
|--------|-------|-------|-------|-------|-------|
| svs-math | built-in | built-in | built-in | built-in | Shared lib, not a hook module |
| svs-fees | yes | planned | planned | planned | Pure math, compatible with all variants |
| svs-caps | yes | planned | planned | planned | Reads deposit amounts, works with any balance model |
| svs-locks | yes | planned | planned | planned | Tracks share timestamps, variant-agnostic |
| svs-access | yes | planned | planned | planned | Whitelist/merkle, variant-agnostic |
| svs-rewards | scaffolding | - | - | - | Needs design for confidential variants |
| svs-oracle | scaffolding | - | - | - | Needs design for stored balance interaction |

**Key constraint**: Modules that read or enforce balance amounts (fees, caps) must account for the balance model. In stored-balance vaults (SVS-2/4), the module sees `vault.total_assets` rather than `asset_vault.amount`. In confidential vaults (SVS-3/4), share balances are encrypted, so modules like `svs-locks` that track share state must use the vault's internal accounting rather than reading token balances.

When adding module support to a new variant, verify:
- The module's input data is available in that variant's account context
- Rounding behavior is preserved (vault always wins)
- The remaining_accounts pattern works with the variant's instruction layout

## Development Workflow

### Branching

Always branch before starting work:

```bash
git checkout -b <type>/<scope>-<description>
# Examples:
# feat/modules-oracle-integration
# fix/svs-2-sync-rounding
# docs/svs-5-spec-draft
```

Types: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`

### Build, Format, Lint, Test

Every change must pass this sequence before committing:

```bash
anchor build                    # compile programs
cargo fmt --all                 # format Rust
cargo clippy --all-targets      # lint Rust
anchor test                     # run integration tests
```

For module work:

```bash
anchor build -p svs-1 -- --features modules
yarn test:modules
```

For SDK work:

```bash
cd sdk/core
yarn build
yarn test
```

### Commits

Use conventional commit messages:

```
feat(svs-1): add deposit cap enforcement via module hooks
fix(sdk): correct share conversion rounding in preview functions
docs: add SVS-6 async vault specification
test(modules): add fee edge cases for zero-amount deposits
```

Update `CHANGELOG.md` for any user-facing change. Follow the existing format (Keep a Changelog, grouped by Added/Changed/Fixed/Security).

## Implementing a New SVS Standard

Future vault variants (SVS-5 through SVS-12) have draft specs in `docs/`. Implementing a new standard touches every layer of the stack. Follow this checklist completely.

### Step 1: Write or refine the spec

Create or update `docs/specs-SVS-<N>.md`. The spec must define:
- The balance model (live vs stored, or a new model)
- The privacy model (public vs confidential, or a new model)
- How core operations (deposit, mint, withdraw, redeem) behave
- View function semantics (totalAssets, convertToShares, convertToAssets, previews, maxes)
- Any new instructions or account state beyond the base vault
- Which existing modules are compatible and which need adaptation

### Step 2: Generate a program ID

```bash
solana-keygen new -o programs/svs-<N>/keypair.json
solana address -k programs/svs-<N>/keypair.json
```

Keep the keypair local. Use the output address in the next step.

### Step 3: Create the program

```bash
cp -r programs/svs-1 programs/svs-<N>
```

Update these files in the new program directory:

- **`Cargo.toml`**: Change crate name to `svs-<N>`, update `declare_id!()` with the generated program ID
- **`src/lib.rs`**: Update `declare_id!()` macro with the generated address

Register in root config:

- **`Cargo.toml`** (workspace root): Add `"programs/svs-<N>"` to `[workspace] members`
- **`Anchor.toml`**: Add program ID under `[programs.devnet]` and `[programs.localnet]`

### Step 4: Define the account structure

Design your vault account struct. Calculate space as:

```
space = 8 (discriminator) + struct fields size
```

Field sizes: `Pubkey` = 32, `u64` = 8, `u8` = 1, `bool` = 1, `i64` = 8, `String` = 4 + len

For reference:
- SVS-1/2 `Vault`: 8 + 211 = 219 bytes
- SVS-3/4 `ConfidentialVault`: 8 + 244 = 252 bytes

If your variant adds fields (e.g., SVS-5 streaming adds `stream_start: i64`, `stream_end: i64`, `stream_rate: u64`), add their sizes to the base. Document the calculation in your spec.

**Important**: SVS-1/2 share the `Vault` account type and discriminator. SVS-3/4 share `ConfidentialVault`. If your variant uses a new account struct name, the IDL and SDK will use a different discriminator. Plan for this in step 6.

### Step 5: Implement instruction handlers

Every instruction handler follows the 7-step pattern:

1. **Validate** - account constraints, signer checks, state preconditions
2. **Read state** - load current assets, shares, balances
3. **Compute** - conversion math, fee calculation
4. **Slippage check** - compare against user-provided min/max bounds
5. **Execute CPIs** - token transfers, mints, burns
6. **Update state** - write to vault account (stored-balance variants only)
7. **Emit event** - log the operation for indexers

Key math rules:
- Virtual offset: `10^(9 - asset_decimals)` prevents inflation attacks
- Rounding always favors the vault (protects existing shareholders):
  - `deposit` / `redeem`: floor (user gets fewer shares / fewer assets)
  - `mint` / `withdraw`: ceiling (user pays more assets / burns more shares)
- Use `checked_add`, `checked_sub`, `checked_mul`, `checked_div` everywhere
- Intermediate calculations use `u128` to prevent overflow

### Step 6: Wire in module support

New standards should support existing modules from day one where feasible. In the new program:

1. Add module crates as optional dependencies in `Cargo.toml` (same pattern as SVS-1)
2. Add `svs-module-hooks` as an optional dependency and import shared hooks with `&crate::ID`
3. Call hooks at the same points in instruction handlers (after compute, before CPI)
4. Test that each module works correctly with the new variant's balance/privacy model

If a module is fundamentally incompatible (e.g., `svs-rewards` with confidential balances), document why in the spec and in the module compatibility table above.

### Step 7: Update the SDK

See [SDK and CLI Expansion](#sdk-and-cli-expansion) below.

### Step 8: Add tests

Create `tests/svs-<N>.ts` covering:
- Initialization (happy path + invalid params)
- All core operations (deposit, mint, withdraw, redeem)
- View function accuracy against hand-calculated values
- Edge cases (zero amounts, minimum deposit of 1000 base units, max values)
- Multi-user scenarios (sequential deposits, proportional withdrawals)
- Rounding behavior verification (vault always benefits)
- Module integration (if supported, test fees/caps/locks/access with the new variant)

Register the test file:
- **`Anchor.toml`**: Add to the `[scripts] test` pattern (e.g., `tests/svs-<N>.ts`)

### Step 9: Document

These files must be created or updated:

| File | Action |
|------|--------|
| `docs/SVS-<N>.md` | Create: detailed specification, account layout, instruction reference |
| `docs/specs-SVS-<N>.md` | Update: mark as implemented, link to program |
| `README.md` | Update: add to SVS variants table, update test counts |
| `CHANGELOG.md` | Update: add entry under next version |
| `docs/ARCHITECTURE.md` | Update: add to account sizes table, balance model notes |
| `docs/TESTING.md` | Update: add test counts and any variant-specific test notes |
| `CONTRIBUTING.md` | Update: module compatibility table if applicable |

### Step 10: CI verification

Before opening a PR, verify:
- `anchor build` compiles all programs including the new one
- `anchor test` passes all existing tests plus the new ones
- `cd sdk/core && yarn build && yarn test` passes with SDK changes
- `anchor build -p svs-<N> -- --features modules` compiles (if module support added)

CI (`.github/workflows/test.yml`) tests on Node 20.x and 22.x automatically. No workflow changes are needed unless your variant requires special setup (e.g., proof backend for confidential variants).

## Implementing a New Module

Modules are optional on-chain extensions compiled behind feature flags. They're passed as `remaining_accounts` so existing vaults remain backward compatible.

### Step 1: Create the module crate

```bash
mkdir -p modules/svs-<name>/src
```

A module crate is a plain Rust library (no Anchor dependency). It defines:
- A config account structure (for PDA storage)
- Pure functions for validation/calculation
- Error types

Look at `modules/svs-fees/` or `modules/svs-caps/` for the pattern.

Create `modules/svs-<name>/Cargo.toml`:
```toml
[package]
name = "svs-<name>"
version = "0.1.0"
edition = "2021"

[dependencies]
# Keep dependencies minimal - no anchor-lang
```

Register in root `Cargo.toml` workspace members.

### Step 2: Design the config PDA

Each module stores its configuration in a PDA derived from the vault address:

```
seeds = ["<module_name>", vault.key()]
```

Document the account size calculation (8-byte discriminator + fields). Keep the config struct minimal - only store what's needed for on-chain enforcement.

### Step 3: Wire it into vault programs

In `programs/svs-1/Cargo.toml`, add as an optional dependency:

```toml
[dependencies]
svs-<name> = { path = "../../modules/svs-<name>", optional = true }

[features]
modules = ["svs-fees", "svs-caps", "svs-locks", "svs-access", "svs-<name>"]
```

Add hooks to `modules/svs-module-hooks/src/hooks.rs`, updating the internal deserialization struct if needed. Hooks are gated behind `#[cfg(feature = "modules")]` in each program's instruction handlers.

Decide which hook points your module needs:
- **Pre-deposit/mint**: access control, cap enforcement, entry fee calculation
- **Pre-withdraw/redeem**: access control, lock enforcement, exit fee calculation
- **Post-operation**: reward tracking, event emission

### Step 4: Add initialization instruction

Create an instruction for initializing the module's config PDA. Follow the pattern in existing module init instructions. The authority that initializes the vault should also initialize module configs.

### Step 5: Plan cross-variant support

If the module is variant-agnostic (pure math or access control), plan to wire it into SVS-2/3/4 as well. If it depends on balance model details, document the constraints.

### Step 6: Update the SDK

Add module support to `sdk/core/src/modules.ts`:
- Config account type definition
- Initialization helper
- Query/display helpers for CLI

Update `sdk/core/src/cli/` if the module needs CLI commands (e.g., `solana-vault set-fees`).

### Step 7: Test

Test individual module behavior and cross-module interactions:

```bash
anchor build -p svs-1 -- --features modules
anchor test --skip-build -- tests/modules.ts
```

Test cases should cover:
- Config initialization and updates
- Enforcement during deposit/mint and withdraw/redeem
- Edge cases (zero fees, max caps, expired locks)
- Interaction with other modules (e.g., fees + caps together)
- Graceful skip when module config is not passed in remaining_accounts

### Step 8: Document

| File | Action |
|------|--------|
| `CONTRIBUTING.md` | Update module compatibility table |
| `README.md` | Add module to the modules list |
| `docs/ARCHITECTURE.md` | Add module PDA seeds and account sizes |
| `CHANGELOG.md` | Add entry |

## SDK and CLI Expansion

When adding a new SVS standard or module, the SDK and CLI must be updated so users can interact with the new functionality from TypeScript and the command line.

### SDK Class Hierarchy

The SDK uses class inheritance to handle variant differences:

```
SolanaVault          (SVS-1: base class, live balance, public)
  └─ ManagedVault    (SVS-2: extends with sync(), stored balance)
```

For confidential variants (SVS-3/4), the `@stbr/svs-privacy-sdk` in `sdk/privacy/` provides helpers for ZK proof generation and encrypted balance handling.

When adding a new variant, decide:
- **If it extends an existing balance model** (e.g., SVS-5 streaming extends live balance): create a new class extending `SolanaVault` or `ManagedVault`
- **If it introduces a new model**: create a new base class implementing the same interface

### SDK Checklist for New Variants

| File | Action |
|------|--------|
| `sdk/core/src/svs-<N>.ts` | Create: new vault class with variant-specific methods |
| `sdk/core/src/index.ts` | Update: export the new class |
| `sdk/core/src/pda.ts` | Update: add PDA derivation if seeds differ from base |
| `sdk/core/src/math.ts` | Update: only if conversion math changes |
| `sdk/core/src/modules.ts` | Update: if module interaction differs for this variant |
| `sdk/core/tests/svs-<N>.test.ts` | Create: SDK unit tests for the new class |
| `sdk/core/package.json` | Update: bump version |

### IDL and Account Discriminators

Anchor generates IDLs per program. Each program has its own IDL in `target/idl/svs_<N>.json` after building. The SDK uses these to deserialize accounts.

If your variant uses a **new account struct name** (e.g., `StreamingVault` instead of `Vault`), the Anchor discriminator changes. The SDK must fetch accounts using the correct discriminator:

```typescript
// SVS-1/2 use "Vault" discriminator
program.account.vault.fetch(vaultPDA)

// SVS-3/4 use "ConfidentialVault" discriminator
program.account.confidentialVault.fetch(vaultPDA)

// SVS-5 would use "StreamingVault" discriminator
program.account.streamingVault.fetch(vaultPDA)
```

Make sure the new SDK class uses the correct account type name from the IDL.

### CLI Checklist for New Variants

The CLI lives in `sdk/core/src/cli/`. When adding a new variant:

| File | Action |
|------|--------|
| `sdk/core/src/cli/commands/` | Add variant-specific commands (e.g., `stream/` for SVS-5) |
| `sdk/core/src/cli/index.ts` | Register new command groups |
| `docs/CLI.md` | Document new commands with examples |

Existing commands (deposit, withdraw, info, etc.) should work across variants where the core interface is the same. Only add new commands for variant-specific functionality (e.g., `sync` for SVS-2, `stream-yield` for SVS-5).

### NPM Publishing

After merging, the SDK is published via `.github/workflows/publish.yml` on GitHub release creation. Bump the version in `sdk/core/package.json` as part of your PR:
- New SVS variant or breaking change: minor bump (e.g., 0.3.0 → 0.4.0)
- New module or non-breaking feature: minor bump
- Bug fix: patch bump (e.g., 0.3.0 → 0.3.1)

## Testing

| Suite | Command | Count |
|-------|---------|-------|
| Integration (all vaults) | `anchor test` | 256 |
| SDK unit tests | `cd sdk/core && yarn test` | 460 |
| Rust unit tests | `cargo test --workspace` | varies |
| Module tests | `yarn test:modules` | varies |
| Proof backend | `cd proofs-backend && cargo test` | 19 |
| Fuzz / invariants | `trident fuzz` (in `trident-tests/`) | varies |

### Writing tests

- Validate math with known inputs/outputs, not just "doesn't crash"
- Test rounding direction explicitly (vault must always win)
- Check invariants: `total_shares * assets_per_share >= total_assets` (within rounding)
- Test with multiple decimal configurations (0, 6, 9)

### Module testing

When testing modules, verify both individual and combined behavior:

```typescript
// Test single module
it("enforces deposit cap", ...)

// Test module combinations
it("applies entry fee AND enforces cap on net amount", ...)

// Test graceful skip
it("deposits succeed when module config not passed", ...)
```

Build with the modules feature before running module tests:
```bash
anchor build -p svs-1 -- --features modules
anchor test --skip-build -- tests/modules.ts
```

### SVS-3/4 test requirements

Confidential transfer tests require the proof backend running. If you're only working on SVS-1/2 or modules, you can skip SVS-3/4 tests:

```bash
anchor test -- tests/svs-1.ts tests/svs-2.ts tests/modules.ts
```

## Code Standards

### Rust (Programs & Modules)

- No `unwrap()` - use `ok_or(ErrorCode::...)` or `checked_*` methods
- No unchecked arithmetic - always `checked_add`, `checked_sub`, etc.
- Store PDA bumps in account state, never recalculate
- Validate account owners, signers, and PDA derivations in constraints
- Validate CPI target program IDs before trusting return data
- Keep instruction handlers focused - extract shared logic to helpers only when used 3+ times

### TypeScript (SDK & Tests)

- Use `BN` for all on-chain numeric values
- Derive PDAs using the utility functions in `sdk/core/src/pda.ts`
- Handle errors with descriptive messages, not empty catch blocks
- Anchor workspace pattern for test setup

### What to avoid

- Comments stating the obvious
- Abstractions for one-time operations
- Defensive try/catch blocks not present elsewhere in the codebase
- Unused imports or dependencies
- Features, refactors, or "improvements" beyond the scope of your change
- `// TODO: implement` without a linked issue

## Security Rules

These are non-negotiable:

1. **Rounding favors the vault.** Never round in the user's favor on entry or exit.
2. **Virtual offset is mandatory.** Every vault uses `10^(9 - asset_decimals)` to prevent share price manipulation via small donations (inflation attack). Asset decimals must be <= 9.
3. **No direct token transfers to manipulate share price.** Live balance vaults (SVS-1/3) are designed to handle this safely via the virtual offset.
4. **Slippage protection on every user-facing operation.** Users specify min/max bounds; the program enforces them.
5. **Checked arithmetic everywhere.** Overflow in share/asset conversion is a critical vulnerability.
6. **Devnet first.** Never deploy to mainnet without explicit confirmation.
7. **Module configs are authority-gated.** Only the vault authority can initialize or update module configurations.

## Pull Request Process

1. Branch from `main` using the naming convention above
2. Make your changes, ensuring build/format/lint/test all pass
3. Open a PR against `main`
4. In the PR description, include:
   - What the change does and why
   - How to test it
   - Any security considerations
   - For new variants: completed checklist from [Implementing a New SVS Standard](#implementing-a-new-svs-standard)
   - For new modules: completed checklist from [Implementing a New Module](#implementing-a-new-module)
5. CI runs tests on Node 20.x and 22.x - both must pass
6. Review checklist (applied by maintainers):
   - No AI slop (excessive comments, redundant validation, style inconsistencies)
   - Error handling matches existing patterns
   - No unnecessary abstractions
   - Security checks present where needed
   - Module compatibility table updated if applicable
   - SDK exports updated and tested
   - Documentation files updated (README, CHANGELOG, relevant docs/)
   - Test counts in TESTING.md updated

### PR size guidelines

- **New SVS standards should land in a single PR.** A new variant touches the program, SDK, CLI, tests, and docs — shipping these together ensures the standard is complete and reviewable as a cohesive unit. Use the checklist in [Implementing a New SVS Standard](#implementing-a-new-svs-standard) to make sure nothing is missed.
- **Bug fixes, module additions, and other changes should be scoped tightly.** One fix per PR. If a fix touches multiple layers (program + SDK), that's fine, but don't bundle unrelated changes.

## Questions?

Open an issue on the repository. For spec discussions about future SVS variants, prefix your issue title with `[RFC]`.
