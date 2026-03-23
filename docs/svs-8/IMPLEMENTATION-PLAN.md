# SVS-8 Implementation Plan

## Phase Overview

| Phase | Scope | Status |
|---|---|---|
| **Phase 0** | Design documentation (`docs/svs-8/`) | Complete |
| **Phase 1** | Oracle module enhancement (`modules/svs-oracle/`) | Complete |
| **Phase 2** | Program implementation (`programs/svs-8/`) | Complete |
| **Phase 3** | Devnet scripts (`scripts/svs-8/`) | Partial |
| **Phase 4** | Integration tests (`tests/svs-8.ts`) | Complete (27 tests) |
| **Phase 5** | TypeScript SDK (`sdk/core/src/multi-asset-vault.ts`) | Complete |
| **Phase 6** | Devnet deployment | TODO |
| **Phase 7** | Mainnet deployment | TODO |

## Phase 0: Documentation

Created `docs/svs-8/` with 4 design documents:
- `DESIGN-DECISIONS.md` — Oracle, rebalance, redeem, weight, naming decisions
- `ARCHITECTURE.md` — State layouts, remaining accounts, oracle integration, math
- `INSTRUCTION-SPECS.md` — All 16 instructions with accounts, validation, compute
- `IMPLEMENTATION-PLAN.md` — This file

## Phase 1: Oracle Module Enhancement

Extended `modules/svs-oracle/` with generic provider interface:

### Files created
| File | Purpose |
|---|---|
| `src/provider.rs` | `OracleType` enum, `NormalizedPrice` struct, `read_oracle_price()` dispatcher |
| `src/providers/mod.rs` | Feature-gated module declarations |
| `src/providers/custom.rs` | `[price_u64, updated_at_i64]` format parser |
| `src/providers/pyth.rs` | Pyth provider stub (feature: `pyth`) |
| `src/providers/switchboard.rs` | Switchboard provider stub (feature: `switchboard`) |

### Files modified
| File | Change |
|---|---|
| `Cargo.toml` | Added `pyth`, `switchboard`, `custom` feature flags |
| `src/lib.rs` | Added `pub mod provider; pub mod providers;` + re-exports |
| `src/error.rs` | Added `UnsupportedOracleType` variant |

### Test coverage
- 19 unit tests + 3 doc-tests pass
- Custom provider: `test_custom_read_price`, `test_custom_read_price_short_data`, `test_read_oracle_price_custom`, `test_read_oracle_price_custom_stale`, `test_read_oracle_price_custom_zero_price`
- OracleType: `test_oracle_type_from_u8`, `test_unsupported_oracle_type`

## Phase 2: Program Implementation

### File manifest

| File | Lines | Purpose |
|---|---|---|
| `src/lib.rs` | 135 | Program entrypoint, 15 instructions + 4 views + 1 test-util |
| `src/state.rs` | 57 | `MultiAssetVault` (149 bytes), `AssetEntry` (142 bytes) |
| `src/constants.rs` | 12 | Seeds, limits, MAX_ORACLE_STALENESS |
| `src/math.rs` | 104 | `mul_div`, `total_portfolio_value`, `portfolio_convert_to_shares/assets`, `asset_value_in_base` |
| `src/remaining.rs` | 84 | `ParsedAssetEntry`, `read_token_balance` |
| `src/error.rs` | 82 | 26 error codes |
| `src/events.rs` | 91 | 10 event types |
| `src/instructions/initialize.rs` | 118 | Vault + Token-2022 mint creation |
| `src/instructions/add_asset.rs` | 111 | Asset addition with weight validation |
| `src/instructions/remove_asset.rs` | 59 | Asset removal (close entry) |
| `src/instructions/update_weights.rs` | 66 | Atomic weight update via remaining_accounts |
| `src/instructions/deposit_single.rs` | 216 | Single-asset deposit with oracle pricing |
| `src/instructions/deposit_proportional.rs` | 196 | Proportional deposit (6 accounts/asset) |
| `src/instructions/redeem_single.rs` | 129 | Proportional single-asset redeem (no oracle) |
| `src/instructions/redeem_proportional.rs` | 153 | Proportional basket redeem (5 accounts/asset) |
| `src/instructions/rebalance.rs` | 129 | Generic swap with balance verification |
| `src/instructions/admin.rs` | 66 | Pause/unpause/transfer_authority |
| `src/instructions/view.rs` | 238 | 4 view functions via set_return_data |
| `src/instructions/test_utils.rs` | 36 | `set_oracle_data` (test-utils feature) |
| `src/instructions/mod.rs` | 39 | Module declarations and re-exports |
| `Cargo.toml` | 35 | Dependencies, feature flags |

### Reference files used
| Source | What was reused |
|---|---|
| `programs/svs-1/` | Vault PDA pattern, deposit/redeem flow, Token-2022 mint init |
| `programs/svs-6/` | Multi-account patterns, no `total_shares` field (PR #41) |
| `modules/svs-math/` | `mul_div` with `Rounding` enum |
| `modules/svs-oracle/` | `validate_freshness`, `PRICE_SCALE` |
| `eth/ERC4626.sol` | Virtual offset math, rounding direction |

## Phase 4: Integration Tests

### File: `tests/svs-8.ts` (991 lines, 27 tests)

| Describe Block | Tests | Coverage |
|---|---|---|
| Initialize | 2 | Vault creation, base_decimals validation |
| Add Asset | 4 | USDC/SOL/BONK addition, weight cap enforcement |
| Update Weights | 4 | Weight update, restore, sum validation, count mismatch |
| Admin | 4 | Pause/unpause, authority transfer, default guard, auth check |
| Deposit Single (validation) | 3 | Zero amount, min deposit, paused guard |
| Redeem Single (validation) | 1 | Zero shares |
| Remove Asset | 2 | Remove + re-add with fresh mint |
| Oracle Integration | 7 | Set prices, USDC deposit, SOL deposit, USDC redeem, slippage, staleness, multi-user |

### Oracle Integration Tests

The `set_oracle_data` instruction (behind `test-utils` feature) enables end-to-end deposit/redeem testing:

1. **Set oracle prices**: USDC=$1, SOL=$150, BONK=$0.000002
2. **First deposit**: 100 USDC → shares minted (virtual offset formula)
3. **Second deposit**: 1 SOL → additional shares reflecting $150 value
4. **Redeem**: Half shares for USDC (proportional to vault balance)
5. **Slippage**: Verify `SlippageExceeded` with unrealistic min_amount_out
6. **Staleness**: Verify `OracleStale` with old timestamp, then restore
7. **Fairness**: Second user deposits and redeems proportionally

## Phase 5: TypeScript SDK

### File: `sdk/core/src/multi-asset-vault.ts` (516 lines)

`MultiAssetVault` class — standalone (does not extend `SolanaVault`).

| Category | Methods |
|---|---|
| PDA helpers | `getVaultAddress`, `getSharesMintAddress`, `getAssetEntryAddress` |
| Factories | `load(program, vaultId)`, `create(program, vaultId, baseDecimals)` |
| State | `refresh()`, `getAssetEntries()`, `state` getter |
| Admin | `addAsset`, `removeAsset`, `updateWeights`, `pause`, `unpause`, `transferAuthority` |
| User ops | `depositSingle`, `redeemSingle` |
| Remaining | `buildOracleRemaining`, `buildDepositProportionalRemaining`, `buildRedeemProportionalRemaining` |
| Views | `totalPortfolioValue`, `previewDeposit`, `previewRedeemSingle` |

Exported via `sdk/core/src/index.ts`.

## Remaining Work

### Phase 6: Devnet Deployment
- Build with production features (no test-utils)
- Deploy via `anchor deploy --provider.cluster devnet`
- Run devnet scripts for manual oracle price verification
- Verify IDL upload

### Phase 7: Mainnet
- Security audit
- Pyth/Switchboard oracle integration (replace mock format)
- Module integration (fees, caps, access control)
- Mainnet deployment with explicit user confirmation

### Future Enhancements
- Migrate SVS-8 oracle reading to `svs_oracle::read_oracle_price()` (from inline `read_mock_oracle_price`)
- Implement actual Pyth and Switchboard providers in svs-oracle
- Add `depositProportional` and `redeemProportional` to SDK class
- Add SDK unit tests
- Performance profiling (CU benchmarks per instruction)
