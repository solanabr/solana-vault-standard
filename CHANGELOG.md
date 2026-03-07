# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-03-06

### Added

#### On-Chain Module System
- **modules/svs-math**: Extracted shared math crate (mul_div, rounding, share/asset conversion)
- **modules/svs-fees**: Entry/exit fee calculation with basis points
- **modules/svs-caps**: Global and per-user deposit cap enforcement
- **modules/svs-locks**: Time-locked shares with duration checking
- **modules/svs-access**: Whitelist/blacklist with merkle proof verification
- **modules/svs-rewards**: Secondary reward token distribution (scaffolding)
- **modules/svs-oracle**: Oracle price validation with staleness checks (scaffolding)

#### SVS-1 Module Instructions (feature: modules)
- `initialize_fee_config` / `update_fee_config` - Configure entry/exit fees (max 10%)
- `initialize_cap_config` / `update_cap_config` - Configure global/per-user caps
- `initialize_lock_config` / `update_lock_config` - Configure share lock duration (max 1 year)
- `initialize_access_config` / `update_access_config` - Configure whitelist/blacklist with merkle root

#### Module Hook Integration
- Deposit/mint handlers now enforce access control, caps, and entry fees when module configs are passed
- Withdraw/redeem handlers now enforce access control, lock checks, and exit fees when module configs are passed
- Modules are optional - if config PDAs not passed, checks are skipped (backward compatible)
- Both deposit() and mint() enforce caps to prevent bypass attacks

### Changed
- Test count: 130 passing (anchor tests) + module crate unit tests

## [0.2.2] - 2025-03-06

### Fixed
- npm: Add repository field for provenance publishing

## [0.2.1] - 2025-03-06

### Fixed
- CI: Handle missing `@stbr/svs-privacy-sdk` gracefully in confidential transfer commands
- CI: Node 22+ compatibility for ts-node (conditional `--no-experimental-strip-types` flag)
- CI: Track yarn.lock for reproducible builds

## [0.2.0] - 2025-03-05

### Added

#### CLI Command Modules
- **fees**: `show`, `configure`, `collect`, `preview` - Manage vault fee configuration
- **cap**: `show`, `configure`, `check` - Manage deposit caps (global and per-user)
- **access**: `show`, `set-mode`, `add`, `remove`, `check`, `generate-proof`, `clear` - Whitelist/blacklist access control with merkle proofs
- **emergency**: `show`, `configure`, `withdraw`, `preview` - Emergency withdrawal with penalty
- **timelock**: `show`, `configure`, `propose`, `execute`, `cancel`, `list`, `clear` - Timelocked governance proposals
- **strategy**: `show`, `add`, `remove`, `deploy`, `recall`, `rebalance`, `health` - DeFi strategy management
- **portfolio**: `show`, `configure`, `deposit`, `redeem`, `rebalance`, `status` - Multi-vault portfolio management
- **ct**: `configure`, `apply-pending`, `status` - Confidential transfer support (SVS-3/SVS-4)

#### Documentation
- `docs/CLI.md` - Comprehensive CLI documentation (860+ lines)
- `docs/DEPLOYMENT.md` - Full deployment guide (devnet, mainnet, multisig, CI/CD)
- `docs/SECURITY.md` - Expanded security checklist with Solana-specific vulnerabilities

#### Tests
- `cli-extended.test.ts` - 36 new tests for extended CLI commands
- Total test coverage: 460 tests passing

### Changed
- Reorganized `.claude/skills/` - Moved documentation files to `docs/`
- Updated skill references to point to docs/

### Removed
- `docs/plan-cli.md` - Planning document no longer needed

## [0.1.0-beta.1] - 2025-03-03

### Added

#### SDK Modules
- **vault.ts** - Core vault operations (deposit, mint, withdraw, redeem)
- **math.ts** - Share/asset conversion with virtual offset protection
- **pda.ts** - PDA derivation utilities
- **fees.ts** - Fee calculation and management
- **cap.ts** - Deposit cap enforcement
- **access-control.ts** - Whitelist/blacklist with merkle proofs
- **emergency.ts** - Emergency withdrawal with penalty
- **timelock.ts** - Proposal management with delays
- **strategy.ts** - DeFi strategy integration
- **multi-asset.ts** - Multi-vault portfolio management
- **events.ts** - Event parsing utilities
- **errors.ts** - Error handling

#### CLI (solana-vault)
- `info` - Display vault information
- `balance` - Check user balance
- `preview` - Preview operations
- `deposit` / `mint` / `withdraw` / `redeem` - Core vault operations
- `pause` / `unpause` - Admin controls
- `sync` - Sync stored balance (SVS-2/SVS-4)
- `transfer-authority` - Transfer vault authority
- `permissions` - View access permissions
- `derive` - PDA derivation
- `convert` - Unit conversion
- `list` - List configured vaults
- `history` - Transaction history
- `dashboard` - Real-time monitoring
- `health` - Vault health checks
- `autopilot` - Automated operations
- `guard` - Safety monitoring
- `batch` - Batch operations
- `config` - Configuration management

#### Documentation
- `docs/SDK.md` - TypeScript SDK reference
- `docs/SVS-1.md` - Live balance vault specification
- `docs/SVS-2.md` - Stored balance vault specification
- `docs/SVS-3.md` - Confidential live balance vault
- `docs/SVS-4.md` - Confidential stored balance vault
- `docs/ARCHITECTURE.md` - System architecture
- `docs/PRIVACY.md` - Privacy model
- `docs/TESTING.md` - Testing guide

### Security
- Virtual offset protection against inflation attacks
- Vault-favoring rounding on all operations
- Checked arithmetic throughout
- Slippage protection on all user operations

[Unreleased]: https://github.com/solanabr/tokenized-vault-standard/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/solanabr/tokenized-vault-standard/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/solanabr/tokenized-vault-standard/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/solanabr/tokenized-vault-standard/compare/v0.1.0-beta.1...v0.2.0
[0.1.0-beta.1]: https://github.com/solanabr/tokenized-vault-standard/releases/tag/v0.1.0-beta.1
