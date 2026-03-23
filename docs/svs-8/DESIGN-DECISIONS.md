# SVS-8 Design Decisions

## Oracle Format

**Decision**: Mock format `[price_u64 LE, updated_at_i64 LE]` (16 bytes, program-owned accounts).

**Rationale**: The oracle interface must be pluggable. Production deployments replace mock oracles with Pyth or Switchboard feeds. By using a simple byte format that any account can satisfy, the program avoids hard dependency on any oracle SDK at the instruction level. The `svs-oracle` module provides `OracleType` enum (Pyth=0, Switchboard=1, Custom=2) and feature-gated providers for future integration.

**Alternatives considered**:
- Pyth SDK directly: Would lock the program to a single oracle provider and complicate testing.
- Switchboard pull model: Higher latency, more complex account structure.
- Chainlink: No mature Solana SDK at time of implementation.

## Rebalance Model

**Decision**: Generic balance-verification pattern — any swap program, vault verifies pre/post balances.

**Rationale**: The vault records `from_asset_vault.amount` before CPI, invokes an arbitrary swap program via `remaining_accounts`, then reloads both vault accounts and verifies `received >= minimum_out`. This design is swap-program agnostic (Jupiter, Raydium, Orca, or custom) and avoids coupling to any specific DEX.

**Security**: The vault PDA signs the CPI. Only the vault authority can trigger rebalance. Post-CPI `.reload()` prevents stale data. The swap program ID comes from remaining_accounts[0] and is not validated against a whitelist — this is intentional to preserve composability, with the authority trust boundary providing the security guarantee.

## Redeem Single (No Oracle)

**Decision**: Proportional model `amount_out = shares * asset_vault.amount / total_shares` (floor rounding).

**Rationale**: Single-asset redemption uses direct balance proportion, not oracle-priced value. This:
1. Eliminates oracle dependency for redemptions (always available, even if oracles are stale).
2. Prevents single-asset drain attacks — a user redeeming from one asset only gets their proportional share of that asset's balance.
3. Simplifies the account structure (no remaining_accounts needed for redeem_single).

**Tradeoff**: Users redeeming a single asset may receive less value than their shares represent if the portfolio is imbalanced. This is by design — it incentivizes proportional redemption or rebalancing.

## No `total_shares` on State

**Decision**: Read `shares_mint.supply` directly instead of storing a `total_shares` field.

**Rationale**: Following the PR #41 pattern (SVS-6), storing `total_shares` creates a consistency risk — the stored value can diverge from the actual mint supply if a CPI path is missed. Reading `shares_mint.supply` is the single source of truth and costs only one additional account deserialization, which Anchor already performs via the `shares_mint` constraint.

## Weight Invariant

**Decision**: `sum <= 10000` during setup, `== 10000` for financial operations.

**Rationale**: Assets are added incrementally (e.g., USDC at 50%, then SOL at 30%, then BONK at 20%). Requiring exact 10000 on each `add_asset` would force simultaneous addition of all assets. The two-phase approach:
- `add_asset`: `current_sum + new_weight <= 10000` — allows incremental growth.
- `update_weights`: `sum(new_weights) == 10000` — atomic rebalance of all weights.
- `deposit_*` / `redeem_*` / `rebalance`: Guards require `sum == 10000` — blocks financial ops until weights are fully allocated.
- `remove_asset`: Closes entry, sum drops below 10000. Financial ops blocked until `update_weights` restores it.

## State Naming

**Decision**: `MultiAssetVault` (not `BasketVault` or `IndexVault`).

**Rationale**: Matches the SVS-08 specification naming convention. "Multi-Asset" is descriptive and unambiguous. "Basket" implies a specific financial product. "Index" implies passive tracking. The vault supports both active management (rebalance) and passive holding, so a neutral name is appropriate.

## Virtual Offset (Inflation Protection)

**Decision**: `decimals_offset = 9 - base_decimals`, applied as `virtual_shares = supply + 10^offset`, `virtual_value = total_value + 1`.

**Rationale**: Prevents the first-depositor inflation attack where an attacker deposits 1 wei, donates tokens to inflate share price, then front-runs other depositors. The virtual offset ensures the first deposit receives shares proportional to a non-trivial denominator. With `base_decimals = 6` (USDC), offset = 3, so `10^3 = 1000` virtual shares exist before any deposit.

## Floor Rounding (Vault-Favoring)

**Decision**: All share/asset conversions use `Rounding::Floor`.

**Rationale**: Per the ERC-4626 standard, rounding must always favor the vault (existing shareholders) over the individual user. Floor rounding on deposits means users receive slightly fewer shares; floor rounding on redemptions means users receive slightly fewer assets. This prevents rounding-based extraction attacks.

## PR #31 Post-Mortem

The first SVS-8 implementation attempt (PR #31) failed due to:
1. **Scope creep**: Attempted to implement all instructions, oracle integration, modules, and SDK simultaneously.
2. **Compilation failures**: Lifetime issues with `Account::try_from` on remaining_accounts — resolved by creating `ParsedAssetEntry` for raw byte parsing.
3. **Module coupling**: Tried to integrate `svs-fees`, `svs-caps`, etc. before the core was stable.

**Lesson applied**: Phase 2 focused exclusively on core instructions with module support behind `#[cfg(feature = "modules")]`. Oracle integration tests were deferred to a separate phase with `set_oracle_data` test utility.

## Token-2022 for Shares, SPL Token for Assets

**Decision**: Shares mint uses Token-2022 (`Token2022`); asset vaults use standard SPL Token via `TokenInterface`.

**Rationale**: Token-2022 provides future extensibility for share tokens (transfer hooks, metadata, confidential balances). Asset vaults use `TokenInterface` to support both SPL Token and Token-2022 assets, determined by the `asset_token_program` passed at deposit/redeem time.

## Stored PDA Bumps

**Decision**: Both `MultiAssetVault.bump` and `AssetEntry.bump` are stored at init time and reused.

**Rationale**: `find_program_address` costs ~1500 CU per call. Storing the canonical bump at initialization and using it for all subsequent PDA derivations saves significant compute across the 11 instructions. The bump is validated via Anchor's `bump = vault.bump` constraint.
