use anchor_lang::prelude::*;

use crate::constants::TRANCHED_VAULT_SEED;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum WaterfallMode {
    #[default]
    Sequential = 0,
    ProRataYieldSequentialLoss = 1,
}

#[account]
pub struct TranchedVault {
    pub authority: Pubkey,
    pub manager: Pubkey,
    pub asset_mint: Pubkey,
    pub asset_vault: Pubkey,
    pub total_assets: u64,
    pub num_tranches: u8,
    pub decimals_offset: u8,
    pub bump: u8,
    pub paused: bool,
    pub wiped: bool,
    pub priority_bitmap: u8,
    pub vault_id: u64,
    pub waterfall_mode: WaterfallMode,
    pub _reserved: [u8; 64],
}

impl TranchedVault {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // authority
        32 +  // manager
        32 +  // asset_mint
        32 +  // asset_vault
        8 +   // total_assets
        1 +   // num_tranches
        1 +   // decimals_offset
        1 +   // bump
        1 +   // paused
        1 +   // wiped
        1 +   // priority_bitmap
        8 +   // vault_id
        1 +   // waterfall_mode
        64; // _reserved

    pub const SEED_PREFIX: &'static [u8] = TRANCHED_VAULT_SEED;
}

#[account]
pub struct Tranche {
    pub vault: Pubkey,
    pub shares_mint: Pubkey,
    pub shares_mint_bump: u8,
    pub total_shares: u64,
    pub total_assets_allocated: u64,
    pub priority: u8,
    pub subordination_bps: u16,
    pub target_yield_bps: u16,
    pub cap_bps: u16,
    pub index: u8,
    pub bump: u8,
    pub _reserved: [u8; 31],
}

impl Tranche {
    pub const LEN: usize = 8 +  // discriminator
        32 +  // vault
        32 +  // shares_mint
        1 +   // shares_mint_bump
        8 +   // total_shares
        8 +   // total_assets_allocated
        1 +   // priority
        2 +   // subordination_bps
        2 +   // target_yield_bps
        2 +   // cap_bps
        1 +   // index
        1 +   // bump
        31; // _reserved
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum AccessMode {
    #[default]
    Open,
    Whitelist,
    Blacklist,
}

#[cfg(feature = "modules")]
pub mod module_state {
    use super::*;

    pub use svs_module_hooks::{
        ACCESS_CONFIG_SEED, CAP_CONFIG_SEED, FEE_CONFIG_SEED, LOCK_CONFIG_SEED,
    };

    #[account]
    pub struct FeeConfig {
        pub vault: Pubkey,
        pub fee_recipient: Pubkey,
        pub entry_fee_bps: u16,
        pub exit_fee_bps: u16,
        pub management_fee_bps: u16,
        pub performance_fee_bps: u16,
        pub high_water_mark: u64,
        pub last_fee_collection: i64,
        pub bump: u8,
    }

    impl FeeConfig {
        pub const LEN: usize = 8 + 32 + 32 + 2 + 2 + 2 + 2 + 8 + 8 + 1;
    }

    #[account]
    pub struct CapConfig {
        pub vault: Pubkey,
        pub global_cap: u64,
        pub per_user_cap: u64,
        pub bump: u8,
    }

    impl CapConfig {
        pub const LEN: usize = 8 + 32 + 8 + 8 + 1;
    }

    #[account]
    pub struct LockConfig {
        pub vault: Pubkey,
        pub lock_duration: i64,
        pub bump: u8,
    }

    impl LockConfig {
        pub const LEN: usize = 8 + 32 + 8 + 1;
    }

    #[account]
    pub struct AccessConfig {
        pub vault: Pubkey,
        pub mode: AccessMode,
        pub merkle_root: [u8; 32],
        pub bump: u8,
    }

    impl AccessConfig {
        pub const LEN: usize = 8 + 32 + 1 + 32 + 1;
    }
}

#[cfg(feature = "modules")]
pub use module_state::*;
