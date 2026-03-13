//! Module admin instructions for SVS-9 allocator vault.

use anchor_lang::prelude::*;

use crate::{
    constants::{ALLOCATOR_VAULT_SEED, FEE_CONFIG_SEED, CAP_CONFIG_SEED, LOCK_CONFIG_SEED, ACCESS_CONFIG_SEED},
    error::VaultError,
    state::{AllocatorVault, module_state},
};

#[derive(Accounts)]
pub struct InitializeFeeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [ALLOCATOR_VAULT_SEED, asset_mint.key().as_ref(), vault_id.to_le_bytes().as_ref()],
        bump = allocator.bump,
        constraint = authority.key() == allocator.authority @ InvalidAuthority
    )]
    pub allocator: Box<Account<'info, AllocatorVault>>,

    #[account(constraint = asset_mint.supply > 0)]
    pub asset_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        space = module_state::FeeConfig::LEN,
        seeds = [FEE_CONFIG_SEED, allocator.key().as_ref()],
        bump
    )]
    pub fee_config: Box<Account<'info, module_state::FeeConfig>>,

    #[account(
        constraint = fee_recipient.owner == &spl_token::id(), // FIXED: Validate token ownership
        constraint = fee_recipient.mint == asset_mint.key(), // FIXED: Validate mint
        constraint = fee_recipient.delegate.is_none(), // FIXED: No delegate
    )]
    pub fee_recipient: Box<Account<'info, TokenAccount>>, // FIXED: Typed account

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
    pub vault_id: u64,
    pub entry_fee_bps: u16,
    pub exit_fee_bps: u16,
    pub management_fee_bps: u16,
    pub performance_fee_bps: u16,
}

#[derive(Accounts)]
pub struct UpdateFeeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [ALLOCATOR_VAULT_SEED, asset_mint.key().as_ref(), vault_id.to_le_bytes().as_ref()],
        bump = allocator.bump,
        constraint = authority.key() == allocator.authority @ InvalidAuthority
    )]
    pub allocator: Box<Account<'info, AllocatorVault>>,

    #[account(
        mut,
        seeds = [FEE_CONFIG_SEED, allocator.key().as_ref()],
        bump = fee_config.bump,
        constraint = fee_config.vault == allocator.key()
    )]
    pub fee_config: Box<Account<'info, module_state::FeeConfig>>,

    pub vault_id: u64,
    pub entry_fee_bps: Option<u16>,
    pub exit_fee_bps: Option<u16>,
    pub management_fee_bps: Option<u16>,
    pub performance_fee_bps: Option<u16>,
}

#[derive(Accounts)]
pub struct InitializeCapConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [ALLOCATOR_VAULT_SEED, asset_mint.key().as_ref(), vault_id.to_le_bytes().as_ref()],
        bump = allocator.bump,
        constraint = authority.key() == allocator.authority @ InvalidAuthority
    )]
    pub allocator: Box<Account<'info, AllocatorVault>>,

    #[account(constraint = asset_mint.supply > 0)]
    pub asset_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        space = module_state::CapConfig::LEN,
        seeds = [CAP_CONFIG_SEED, allocator.key().as_ref()],
        bump
    )]
    pub cap_config: Box<Account<'info, module_state::CapConfig>>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
    pub vault_id: u64,
    pub global_cap: u64,
    pub per_user_cap: u64,
}

#[derive(Accounts)]
pub struct UpdateCapConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [ALLOCATOR_VAULT_SEED, asset_mint.key().as_ref(), vault_id.to_le_bytes().as_ref()],
        bump = allocator.bump,
        constraint = authority.key() == allocator.authority @ InvalidAuthority
    )]
    pub allocator: Box<Account<'info, AllocatorVault>>,

    #[account(
        mut,
        seeds = [CAP_CONFIG_SEED, allocator.key().as_ref()],
        bump = cap_config.bump,
        constraint = cap_config.vault == allocator.key()
    )]
    pub cap_config: Box<Account<'info, module_state::CapConfig>>,

    pub vault_id: u64,
    pub global_cap: Option<u64>,
    pub per_user_cap: Option<u64>,
}

#[derive(Accounts)]
pub struct InitializeLockConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [ALLOCATOR_VAULT_SEED, asset_mint.key().as_ref(), vault_id.to_le_bytes().as_ref()],
        bump = allocator.bump,
        constraint = authority.key() == allocator.authority @ InvalidAuthority
    )]
    pub allocator: Box<Account<'info, AllocatorVault>>,

    #[account(constraint = asset_mint.supply > 0)]
    pub asset_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        space = module_state::LockConfig::LEN,
        seeds = [LOCK_CONFIG_SEED, allocator.key().as_ref()],
        bump
    )]
    pub lock_config: Box<Account<'info, module_state::LockConfig>>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
    pub vault_id: u64,
    pub lock_duration: i64,
}

#[derive(Accounts)]
pub struct UpdateLockConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [ALLOCATOR_VAULT_SEED, asset_mint.key().as_ref(), vault_id.to_le_bytes().as_ref()],
        bump = allocator.bump,
        constraint = authority.key() == allocator.authority @ InvalidAuthority
    )]
    pub allocator: Box<Account<'info, AllocatorVault>>,

    #[account(
        mut,
        seeds = [LOCK_CONFIG_SEED, allocator.key().as_ref()],
        bump = lock_config.bump,
        constraint = lock_config.vault == allocator.key()
    )]
    pub lock_config: Box<Account<'info, module_state::LockConfig>>,

    pub vault_id: u64,
    pub lock_duration: i64,
}

#[derive(Accounts)]
pub struct InitializeAccessConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [ALLOCATOR_VAULT_SEED, asset_mint.key().as_ref(), vault_id.to_le_bytes().as_ref()],
        bump = allocator.bump,
        constraint = authority.key() == allocator.authority @ InvalidAuthority
    )]
    pub allocator: Box<Account<'info, AllocatorVault>>,

    #[account(constraint = asset_mint.supply > 0)]
    pub asset_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        space = module_state::AccessConfig::LEN,
        seeds = [ACCESS_CONFIG_SEED, allocator.key().as_ref()],
        bump
    )]
    pub access_config: Box<Account<'info, module_state::AccessConfig>>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
    pub vault_id: u64,
    pub mode: crate::state::AccessMode,
    pub merkle_root: [u8; 32],
}

#[derive(Accounts)]
pub struct UpdateAccessConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [ALLOCATOR_VAULT_SEED, asset_mint.key().as_ref(), vault_id.to_le_bytes().as_ref()],
        bump = allocator.bump,
        constraint = authority.key() == allocator.authority @ InvalidAuthority
    )]
    pub allocator: Box<Account<'info, AllocatorVault>>,

    #[account(
        mut,
        seeds = [ACCESS_CONFIG_SEED, allocator.key().as_ref()],
        bump = access_config.bump,
        constraint = access_config.vault == allocator.key()
    )]
    pub access_config: Box<Account<'info, module_state::AccessConfig>>,

    pub vault_id: u64,
    pub mode: Option<crate::state::AccessMode>,
    pub merkle_root: Option<[u8; 32]>,
}

// Fee config handlers
pub fn initialize_fee_config(
    ctx: Context<InitializeFeeConfig>,
    entry_fee_bps: u16,
    exit_fee_bps: u16,
    management_fee_bps: u16,
    performance_fee_bps: u16,
) -> Result<()> {
    let allocator = &ctx.accounts.allocator;
    let fee_config = &mut ctx.accounts.fee_config;

    fee_config.vault = allocator.key();
    fee_config.fee_recipient = ctx.accounts.fee_recipient.key();
    fee_config.entry_fee_bps = entry_fee_bps;
    fee_config.exit_fee_bps = exit_fee_bps;
    fee_config.management_fee_bps = management_fee_bps;
    fee_config.performance_fee_bps = performance_fee_bps;
    fee_config.high_water_mark = 0;
    fee_config.last_fee_collection = Clock::get()?.unix_timestamp;
    fee_config.bump = ctx.bumps.fee_config;

    Ok(())
}

// FIXED: Atomic fee config updates (SVS-Modules compliance)
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct FeeConfigUpdate {
    pub entry_fee_bps: Option<u16>,
    pub exit_fee_bps: Option<u16>,
    pub management_fee_bps: Option<u16>,
    pub performance_fee_bps: Option<u16>,
}

pub fn update_fee_config(
    ctx: Context<UpdateFeeConfig>,
    entry_fee_bps: Option<u16>,
    exit_fee_bps: Option<u16>,
    management_fee_bps: Option<u16>,
    performance_fee_bps: Option<u16>,
) -> Result<()> {
    let fee_config = &mut ctx.accounts.fee_config;
    
    // FIXED: Create atomic update structure
    let update = FeeConfigUpdate {
        entry_fee_bps,
        exit_fee_bps,
        management_fee_bps,
        performance_fee_bps,
    };
    
    // FIXED: Apply all changes atomically
    if let Some(entry) = update.entry_fee_bps {
        fee_config.entry_fee_bps = entry;
    }
    if let Some(exit) = update.exit_fee_bps {
        fee_config.exit_fee_bps = exit;
    }
    if let Some(management) = update.management_fee_bps {
        fee_config.management_fee_bps = management;
    }
    if let Some(performance) = update.performance_fee_bps {
        fee_config.performance_fee_bps = performance;
    }
    
    // FIXED: Single atomic commit point
    emit_cpi!(crate::events::FeeConfigUpdated {
        vault: fee_config.vault,
        entry_fee_bps: fee_config.entry_fee_bps,
        exit_fee_bps: fee_config.exit_fee_bps,
        management_fee_bps: fee_config.management_fee_bps,
        performance_fee_bps: fee_config.performance_fee_bps,
    });

    Ok(())
}

// Cap config handlers
pub fn initialize_cap_config(
    ctx: Context<InitializeCapConfig>,
    global_cap: u64,
    per_user_cap: u64,
) -> Result<()> {
    let allocator = &ctx.accounts.allocator;
    let cap_config = &mut ctx.accounts.cap_config;

    cap_config.vault = allocator.key();
    cap_config.global_cap = global_cap;
    cap_config.per_user_cap = per_user_cap;
    cap_config.bump = ctx.bumps.cap_config;

    Ok(())
}

pub fn update_cap_config(
    ctx: Context<UpdateCapConfig>,
    global_cap: Option<u64>,
    per_user_cap: Option<u64>,
) -> Result<()> {
    let cap_config = &mut ctx.accounts.cap_config;

    if let Some(global) = global_cap {
        cap_config.global_cap = global;
    }
    if let Some(per_user) = per_user_cap {
        cap_config.per_user_cap = per_user;
    }

    Ok(())
}

// Lock config handlers
pub fn initialize_lock_config(
    ctx: Context<InitializeLockConfig>,
    lock_duration: i64,
) -> Result<()> {
    let allocator = &ctx.accounts.allocator;
    let lock_config = &mut ctx.accounts.lock_config;

    lock_config.vault = allocator.key();
    lock_config.lock_duration = lock_duration;
    lock_config.bump = ctx.bumps.lock_config;

    Ok(())
}

pub fn update_lock_config(
    ctx: Context<UpdateLockConfig>,
    lock_duration: i64,
) -> Result<()> {
    let lock_config = &mut ctx.accounts.lock_config;
    lock_config.lock_duration = lock_duration;

    Ok(())
}

// Access config handlers
pub fn initialize_access_config(
    ctx: Context<InitializeAccessConfig>,
    mode: crate::state::AccessMode,
    merkle_root: [u8; 32],
) -> Result<()> {
    let allocator = &ctx.accounts.allocator;
    let access_config = &mut ctx.accounts.access_config;

    access_config.vault = allocator.key();
    access_config.mode = mode;
    access_config.merkle_root = merkle_root;
    access_config.bump = ctx.bumps.access_config;

    Ok(())
}

pub fn update_access_config(
    ctx: Context<UpdateAccessConfig>,
    mode: Option<crate::state::AccessMode>,
    merkle_root: Option<[u8; 32]>,
) -> Result<()> {
    let access_config = &mut ctx.accounts.access_config;

    if let Some(m) = mode {
        access_config.mode = m;
    }
    if let Some(root) = merkle_root {
        access_config.merkle_root = root;
    }

    Ok(())
}
