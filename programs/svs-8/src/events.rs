//! SVS-8 Multi-Asset Basket Vault — on-chain events.
use anchor_lang::prelude::*;

// ── Vault lifecycle ───────────────────────────────────────────────────────────

#[event]
pub struct VaultInitialized {
      pub vault: Pubkey,
      pub authority: Pubkey,
      pub shares_mint: Pubkey,
      pub vault_id: u64,
}

#[event]
pub struct PauseStateChanged {
      pub vault: Pubkey,
      pub paused: bool,
}

#[event]
pub struct AuthorityTransferred {
      pub vault: Pubkey,
      pub old_authority: Pubkey,
      pub new_authority: Pubkey,
}

// ── Basket management ─────────────────────────────────────────────────────────

/// Emitted when an asset is added to the basket.
#[event]
pub struct AssetAdded {
      pub vault: Pubkey,
      pub asset_mint: Pubkey,
      pub oracle: Pubkey,
      pub target_weight_bps: u16,
      pub index: u8,
}

/// Emitted when an asset is removed from the basket.
#[event]
pub struct AssetRemoved {
      pub vault: Pubkey,
      pub asset_mint: Pubkey,
      pub index: u8,
}

/// Emitted when target weights are updated.
#[event]
pub struct WeightsUpdated {
      pub vault: Pubkey,
      /// New weights in bps, ordered by asset index.
      pub weights: Vec<u16>,
}

// ── Deposits ──────────────────────────────────────────────────────────────────

/// Single-asset deposit event.
#[event]
pub struct Deposit {
      pub vault: Pubkey,
      pub user: Pubkey,
      pub asset_mint: Pubkey,
      pub amount: u64,
      pub shares: u64,
      /// USD-denominated value of the deposited assets.
      pub value: u64,
}

/// Proportional deposit event (all basket assets at once).
#[event]
pub struct ProportionalDeposit {
      pub vault: Pubkey,
      pub user: Pubkey,
      /// Per-asset deposited amounts, ordered by asset index.
      pub amounts: Vec<u64>,
      pub shares: u64,
      pub total_value: u64,
}

// ── Redemptions ───────────────────────────────────────────────────────────────

/// Single-asset redemption event.
#[event]
pub struct RedeemSingle {
      pub vault: Pubkey,
      pub user: Pubkey,
      pub asset_mint: Pubkey,
      pub shares: u64,
      pub amount: u64,
}

/// Proportional redemption event (all basket assets at once).
#[event]
pub struct ProportionalRedeem {
      pub vault: Pubkey,
      pub user: Pubkey,
      pub shares: u64,
      /// Per-asset redeemed amounts, ordered by asset index.
      pub amounts: Vec<u64>,
}

// ── Rebalance ─────────────────────────────────────────────────────────────────

/// Emitted after a successful Jupiter-CPI rebalance swap.
#[event]
pub struct Rebalance {
      pub vault: Pubkey,
      pub from_asset: Pubkey,
      pub to_asset: Pubkey,
      pub amount_in: u64,
      pub amount_out: u64,
}
