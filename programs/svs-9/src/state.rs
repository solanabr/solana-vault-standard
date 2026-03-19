use anchor_lang::prelude::*;

/// SVS-9 Allocator Vault — top-level state.
///
/// Field order follows the official SVS-9 specification for
/// deterministic Borsh serialization and indexer compatibility.
///
/// Memory layout (after 8-byte Anchor discriminator):
/// | offset | size | field             |
/// |--------|------|-------------------|
/// |      8 |   32 | authority         |
/// |     40 |   32 | curator           |
/// |     72 |   32 | asset_mint        |
/// |    104 |   32 | shares_mint       |
/// |    136 |   32 | idle_vault        |
/// |    168 |    8 | vault_id          |
/// |    176 |    8 | total_shares      |
/// |    184 |    2 | idle_buffer_bps   |
/// |    186 |    1 | num_children      |
/// |    187 |    1 | decimals_offset   |
/// |    188 |    1 | bump              |
/// |    189 |    1 | paused            |
/// |    190 |   64 | _reserved         |
#[account]
#[derive(InitSpace)]
pub struct AllocatorVault {
    /// Vault admin — can pause, transfer authority, set curator
    pub authority: Pubkey,
    /// Curator — manages child vault allocations
    pub curator: Pubkey,
    /// Underlying asset mint
    pub asset_mint: Pubkey,
    /// LP token mint (shares) — always Token-2022
    pub shares_mint: Pubkey,
    /// ATA holding unallocated (idle) assets
    pub idle_vault: Pubkey,
    /// Total outstanding shares (canonical supply mirror)
    pub total_shares: u64,
    /// Number of active child vaults
    pub num_children: u8,
    /// Minimum idle ratio in bps (e.g. 1000 = 10%)
    pub idle_buffer_bps: u16,
    /// Virtual offset exponent for inflation-attack protection (0–9)
    pub decimals_offset: u8,
    /// PDA bump seed
    pub bump: u8,
    /// Emergency pause flag
    pub paused: bool,
    /// Unique vault identifier (allows multiple vaults per asset)
    pub vault_id: u64,
    /// Reserved for future upgrades — must be zeroed on init
    pub _reserved: [u8; 64],
}

/// Per-child allocation state — one PDA per (AllocatorVault, ChildVault) pair.
///
/// Memory layout (after 8-byte Anchor discriminator):
/// | offset | size | field                |
/// |--------|------|----------------------|
/// |      8 |   32 | allocator_vault      |
/// |     40 |   32 | child_vault          |
/// |     72 |   32 | child_program        |
/// |    104 |   32 | child_shares_account |
/// |    136 |    2 | target_weight_bps    |
/// |    138 |    2 | max_weight_bps       |
/// |    140 |    8 | deposited_assets     |
/// |    148 |    1 | index                |
/// |    149 |    1 | enabled              |
/// |    150 |    1 | bump                 |
/// |    151 |   64 | _reserved            |
#[account]
#[derive(InitSpace)]
pub struct ChildAllocation {
    /// The allocator vault this allocation belongs to
    pub allocator_vault: Pubkey,
    /// The child vault pubkey
    pub child_vault: Pubkey,
    /// SVS program that owns the child vault
    pub child_program: Pubkey,
    /// ATA where the allocator holds its shares in the child vault
    pub child_shares_account: Pubkey,
    /// Cost-basis tracking: assets deposited into this child
    pub deposited_assets: u64,
    /// Target allocation weight in bps (informational, for rebalancing)
    pub target_weight_bps: u16,
    /// Maximum allocation weight in bps — enforced on allocate/rebalance
    pub max_weight_bps: u16,
    /// Position index within the allocator (0-based)
    pub index: u8,
    /// Whether this child is active
    pub enabled: bool,
    /// PDA bump seed
    pub bump: u8,
    /// Reserved for future upgrades — must be zeroed on init
    pub _reserved: [u8; 64],
}
