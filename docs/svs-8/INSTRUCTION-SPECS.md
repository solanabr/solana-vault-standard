# SVS-8 Instruction Specifications

## 1. `initialize(vault_id: u64, base_decimals: u8)`

Creates a new multi-asset vault and its Token-2022 shares mint.

**Accounts**:
| Account | Type | Constraint |
|---|---|---|
| `authority` | `Signer`, mut | Payer |
| `vault` | `Account<MultiAssetVault>`, init | PDA: `["multi_vault", vault_id.to_le_bytes()]` |
| `shares_mint` | `UncheckedAccount`, mut | PDA: `["shares", vault.key()]` |
| `token_2022_program` | `Program<Token2022>` | |
| `system_program` | `Program<System>` | |
| `rent` | `Sysvar<Rent>` | |

**Validation**:
- `base_decimals <= 9`

**Compute steps**:
1. Create vault account (Anchor `init`)
2. CPI: `SystemProgram.createAccount` for shares mint (Token-2022 sized)
3. CPI: `initialize_mint2` with 9 decimals, vault PDA as authority
4. Set vault fields: authority, shares_mint, decimals_offset = 9 - base_decimals, bump, paused=false, vault_id, num_assets=0, base_decimals, _reserved=[0; 64]

**Events**: `VaultInitialized`

---

## 2. `add_asset(target_weight_bps: u16, oracle_type: u8)`

Adds an asset to the vault basket.

**Accounts**:
| Account | Type | Constraint |
|---|---|---|
| `authority` | `Signer`, mut | `vault.authority == authority.key()` |
| `vault` | `Account<MultiAssetVault>`, mut | PDA validated |
| `asset_mint` | `InterfaceAccount<Mint>` | |
| `oracle` | `UncheckedAccount` | |
| `asset_entry` | `Account<AssetEntry>`, init | PDA: `["asset_entry", vault, asset_mint]` |
| `asset_vault` | `InterfaceAccount<TokenAccount>`, init | ATA(asset_mint, vault) |
| `asset_token_program` | `Interface<TokenInterface>` | |
| `associated_token_program` | `Program<AssociatedToken>` | |
| `system_program` | `Program<System>` | |

**Remaining accounts**: Existing `AssetEntry` accounts (for weight sum validation).

**Validation**:
- `num_assets < MAX_ASSETS (8)`
- `sum(existing_weights) + target_weight_bps <= 10000`

**Compute steps**:
1. Sum weights from remaining_accounts (read offset 137-138 from each)
2. Validate weight cap
3. Init AssetEntry with: vault, asset_mint, asset_vault (ATA), oracle, oracle_type, target_weight_bps, asset_decimals (from mint), index = num_assets, bump
4. Increment `vault.num_assets`

**Events**: `AssetAdded`

---

## 3. `remove_asset()`

Removes an asset from the vault basket. Closes the AssetEntry account.

**Accounts**:
| Account | Type | Constraint |
|---|---|---|
| `authority` | `Signer`, mut | `vault.authority == authority.key()` |
| `vault` | `Account<MultiAssetVault>`, mut | PDA validated |
| `asset_entry` | `Account<AssetEntry>`, mut, close=authority | PDA validated, `entry.vault == vault.key()` |
| `asset_vault` | `InterfaceAccount<TokenAccount>` | `vault.amount == 0` |
| `system_program` | `Program<System>` | |

**Validation**:
- `asset_vault.amount == 0` (cannot remove asset with balance)

**Compute steps**:
1. Record removed index and mint for event
2. Decrement `vault.num_assets`
3. Close asset_entry (rent returned to authority)

**Events**: `AssetRemoved`

**Note**: The ATA (asset_vault) is NOT closed — it persists. This means `add_asset` with the same mint will fail because `init` tries to create an already-existing ATA. Use a fresh mint or close the ATA manually.

---

## 4. `update_weights(new_weights: Vec<u16>)`

Atomically updates all asset weights.

**Accounts**:
| Account | Type | Constraint |
|---|---|---|
| `authority` | `Signer` | `vault.authority == authority.key()` |
| `vault` | `Account<MultiAssetVault>` | PDA validated |

**Remaining accounts**: All `AssetEntry` accounts (writable).

**Validation**:
- `new_weights.len() == num_assets`
- `sum(new_weights) == 10000`
- `remaining_accounts.len() == num_assets`
- Each entry PDA validated

**Compute steps**:
1. Validate weight count and sum
2. For each entry: validate PDA, write new weight at byte offset 137-138

**Events**: `WeightsUpdated`

---

## 5. `deposit_single(amount: u64, min_shares_out: u64)`

Deposits one asset type and mints shares based on oracle-priced portfolio value.

**Accounts**:
| Account | Type | Constraint |
|---|---|---|
| `user` | `Signer`, mut | |
| `vault` | `Account<MultiAssetVault>` | PDA, `!paused` |
| `shares_mint` | `InterfaceAccount<Mint>`, mut | `== vault.shares_mint` |
| `user_shares_account` | `InterfaceAccount<TokenAccount>`, init_if_needed | ATA(shares_mint, user, Token2022) |
| `deposit_asset_mint` | `InterfaceAccount<Mint>` | |
| `deposit_asset_entry` | `Account<AssetEntry>` | PDA, `entry.vault == vault.key()` |
| `deposit_asset_vault` | `InterfaceAccount<TokenAccount>`, mut | `== entry.asset_vault` |
| `user_deposit_account` | `InterfaceAccount<TokenAccount>`, mut | `mint == deposit_asset_mint, owner == user` |
| `asset_token_program` | `Interface<TokenInterface>` | |
| `token_2022_program` | `Program<Token2022>` | |
| `associated_token_program` | `Program<AssociatedToken>` | |
| `system_program` | `Program<System>` | |

**Remaining accounts**: `[entry, vault, oracle]` × num_assets (3 per asset).

**Validation**:
- `amount > 0`
- `amount >= MIN_DEPOSIT_AMOUNT (1000)`
- `remaining_accounts.len() == num_assets * 3`
- `weight_sum == 10000`
- `shares >= min_shares_out`

**Rounding**: Floor (fewer shares minted, favoring vault).

**Events**: `SingleDeposit`

---

## 6. `deposit_proportional(base_amount: u64, min_shares_out: u64)`

Deposits all assets in target weight proportions.

**Accounts**: Similar to deposit_single but without specific asset accounts (uses remaining_accounts for all transfers).

**Remaining accounts**: `[entry, vault, oracle, mint, user_ata, token_program]` × num_assets (6 per asset).

**Compute steps**:
1. Read all entries, validate PDAs, read balances and prices
2. Compute transfer amount per asset: `base_amount * weight_bps / 10000`
3. Compute total deposit value across all assets
4. Convert to shares via virtual offset formula
5. Execute transfers for each asset (skip zero amounts)
6. Mint shares

**Rounding**: Floor on both transfer amounts and shares.

**Events**: `ProportionalDeposit`

---

## 7. `redeem_single(shares: u64, min_amount_out: u64)`

Redeems shares for a single asset. No oracle needed.

**Accounts**:
| Account | Type | Constraint |
|---|---|---|
| `user` | `Signer`, mut | |
| `vault` | `Account<MultiAssetVault>` | PDA, `!paused` |
| `shares_mint` | `InterfaceAccount<Mint>`, mut | `== vault.shares_mint` |
| `user_shares_account` | `InterfaceAccount<TokenAccount>`, mut | `mint == shares_mint, owner == user` |
| `redeem_asset_mint` | `InterfaceAccount<Mint>` | |
| `redeem_asset_entry` | `Account<AssetEntry>` | PDA, `entry.vault == vault.key()` |
| `redeem_asset_vault` | `InterfaceAccount<TokenAccount>`, mut | `== entry.asset_vault` |
| `user_redeem_account` | `InterfaceAccount<TokenAccount>`, mut | `mint == redeem_asset_mint, owner == user` |
| `asset_token_program` | `Interface<TokenInterface>` | |
| `token_2022_program` | `Program<Token2022>` | |

**No remaining accounts required.**

**Validation**:
- `shares > 0`
- `user_shares_account.amount >= shares`
- `amount_out >= min_amount_out`
- `amount_out <= asset_balance`

**Compute**:
```
amount_out = shares * asset_vault.amount / total_shares  (floor)
```

**CPI sequence**: Burn shares (user authority) → Transfer assets (vault PDA authority).

**Rounding**: Floor (fewer assets returned, favoring vault).

**Events**: `SingleRedeem`

---

## 8. `redeem_proportional(shares: u64, min_amounts_out: Vec<u64>)`

Redeems shares for proportional basket of all assets.

**Remaining accounts**: `[entry, vault, mint, user_ata, token_program]` × num_assets (5 per asset).

**Validation**:
- `min_amounts_out.len() == num_assets`
- Each `amount_out[i] >= min_amounts_out[i]`

**Compute**: Per asset: `amount_out = shares * balance / total_shares` (floor).

**CPI sequence**: Burn shares once → Transfer each asset.

**Events**: `ProportionalRedeem`

---

## 9. `rebalance(swap_data: Vec<u8>, minimum_out: u64)`

Rebalances between two vault assets via an external swap program.

**Accounts**:
| Account | Type | Constraint |
|---|---|---|
| `authority` | `Signer` | `vault.authority == authority.key()` |
| `vault` | `Account<MultiAssetVault>` | PDA, `!paused` |
| `from_asset_entry` | `Account<AssetEntry>` | PDA validated |
| `from_asset_vault` | `InterfaceAccount<TokenAccount>`, mut | `== from_entry.asset_vault` |
| `to_asset_entry` | `Account<AssetEntry>` | PDA validated |
| `to_asset_vault` | `InterfaceAccount<TokenAccount>`, mut | `== to_entry.asset_vault` |

**Remaining accounts**: `[swap_program, ...swap_route_accounts]`.

**Compute steps**:
1. Record `from_vault.amount` and `to_vault.amount` before
2. Build instruction from `swap_data` + remaining_accounts metas
3. CPI: `invoke_signed` to swap program (vault PDA signs)
4. `.reload()` both vault accounts
5. Compute `amount_in` = before - after (from), `amount_out` = after - before (to)
6. Require `amount_out >= minimum_out`

**Events**: `Rebalance`

---

## 10. `pause()` / `unpause()`

Emergency halt/resume all financial operations.

**Accounts**:
| Account | Type | Constraint |
|---|---|---|
| `authority` | `Signer` | `vault.authority == authority.key()` |
| `vault` | `Account<MultiAssetVault>`, mut | PDA validated |

**Validation**:
- `pause()`: `!vault.paused` (prevents double-pause)
- `unpause()`: `vault.paused` (prevents double-unpause)

**Events**: `VaultStatusChanged`

---

## 11. `transfer_authority(new_authority: Pubkey)`

Transfers vault admin rights to a new address.

**Accounts**: Same as pause/unpause.

**Validation**:
- `new_authority != Pubkey::default()`

**Events**: `AuthorityTransferred`

---

## 12-15. View Functions

All view functions use `set_return_data()` to return u64 LE bytes. They share the `VaultView` accounts struct.

### `preview_deposit(asset_index: u8, amount: u64)`
Returns shares that would be minted for a deposit. Reads all oracle prices.

### `total_portfolio_value()`
Returns total portfolio value in base units. Reads all oracle prices and balances.

### `preview_redeem_single(asset_index: u8, shares: u64)`
Returns asset amount for redemption. No oracle needed (proportional).

### `convert_shares_to_value(shares: u64)`
Returns base-unit value of shares. Reads all oracle prices.

---

## 16. `set_oracle_data(price: u64, timestamp: i64)` [test-utils only]

Behind `#[cfg(feature = "test-utils")]`. Writes price data to mock oracle accounts.

**Accounts**:
| Account | Type | Constraint |
|---|---|---|
| `authority` | `Signer` | `vault.authority == authority.key()` |
| `vault` | `Account<MultiAssetVault>` | PDA validated |
| `oracle` | `AccountInfo`, mut | `oracle.owner == program_id` |

**Validation**:
- `price > 0`
- `oracle.data.len() >= 16`

**Compute**: Writes `[price LE, timestamp LE]` to oracle account data bytes 0..16.
