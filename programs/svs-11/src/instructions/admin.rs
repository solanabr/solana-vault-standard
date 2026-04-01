use anchor_lang::prelude::*;

use crate::constants::{MAX_DEVIATION_BPS_CAP, ORACLE_TIMELOCK, VAULT_CONFIG_SEED, VAULT_SEED};
use crate::error::VaultError;
use crate::events::{
    AttesterUpdated, AuthorityTransferred, ComplianceOfficerUpdated, ManagerChanged,
    OracleChangeApplied, OracleChangeRequested, OracleConfigUpdated, VaultConfigInitialized,
    VaultStatusChanged,
};
use crate::state::{CreditVault, VaultConfig};

#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, CreditVault>,
}

pub fn pause_handler(ctx: Context<Admin>) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    ctx.accounts.vault.paused = true;

    emit!(VaultStatusChanged {
        vault: ctx.accounts.vault.key(),
        paused: true,
    });

    Ok(())
}

pub fn unpause_handler(ctx: Context<Admin>) -> Result<()> {
    require!(ctx.accounts.vault.paused, VaultError::VaultNotPaused);
    ctx.accounts.vault.paused = false;

    emit!(VaultStatusChanged {
        vault: ctx.accounts.vault.key(),
        paused: false,
    });

    Ok(())
}

// TODO(M-8): Implement two-step authority transfer (request_transfer_authority + accept_authority)
//            matching the pattern in SVS-1 and SVS-2. Requires adding pending_authority: Pubkey
//            to CreditVault state (consume 32 bytes from _reserved).
pub fn transfer_authority_handler(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
    require!(
        new_authority != Pubkey::default(),
        VaultError::InvalidAddress
    );

    let previous_authority = ctx.accounts.vault.authority;
    ctx.accounts.vault.authority = new_authority;

    emit!(AuthorityTransferred {
        vault: ctx.accounts.vault.key(),
        previous_authority,
        new_authority,
    });

    Ok(())
}

pub fn set_manager_handler(ctx: Context<Admin>, new_manager: Pubkey) -> Result<()> {
    require!(new_manager != Pubkey::default(), VaultError::InvalidAddress);

    let old_manager = ctx.accounts.vault.manager;
    ctx.accounts.vault.manager = new_manager;

    emit!(ManagerChanged {
        vault: ctx.accounts.vault.key(),
        old_manager,
        new_manager,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateAttester<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, CreditVault>,

    /// CHECK: Validated as executable below
    pub new_attestation_program_account: UncheckedAccount<'info>,
}

pub fn update_attester_handler(
    ctx: Context<UpdateAttester>,
    new_attester: Pubkey,
    new_attestation_program: Pubkey,
) -> Result<()> {
    require!(
        new_attester != Pubkey::default(),
        VaultError::InvalidAddress
    );
    require!(
        new_attestation_program != Pubkey::default(),
        VaultError::InvalidAddress
    );
    require!(
        ctx.accounts.new_attestation_program_account.key() == new_attestation_program,
        VaultError::InvalidAttestationProgram
    );
    require!(
        ctx.accounts.new_attestation_program_account.executable,
        VaultError::InvalidAttestationProgram
    );

    let old_attester = ctx.accounts.vault.attester;
    let old_attestation_program = ctx.accounts.vault.attestation_program;
    ctx.accounts.vault.attester = new_attester;
    ctx.accounts.vault.attestation_program = new_attestation_program;

    emit!(AttesterUpdated {
        vault: ctx.accounts.vault.key(),
        old_attester,
        new_attester,
        old_attestation_program,
        new_attestation_program,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateOracleConfig<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, CreditVault>,

    /// CHECK: Validated as executable below
    pub new_oracle_program_account: UncheckedAccount<'info>,
}

pub fn update_oracle_config_handler(
    ctx: Context<UpdateOracleConfig>,
    new_nav_oracle: Pubkey,
    new_oracle_program: Pubkey,
    new_max_staleness: i64,
    new_max_deviation_bps: Option<u16>,
) -> Result<()> {
    require!(
        new_nav_oracle != Pubkey::default(),
        VaultError::InvalidAddress
    );
    require!(
        new_oracle_program != Pubkey::default(),
        VaultError::InvalidAddress
    );
    require!(
        ctx.accounts.new_oracle_program_account.key() == new_oracle_program,
        VaultError::OracleInvalidProgram
    );
    require!(
        ctx.accounts.new_oracle_program_account.executable,
        VaultError::OracleInvalidProgram
    );
    require!(
        (60..=86400).contains(&new_max_staleness),
        VaultError::InvalidStalenessConfig
    );

    if let Some(deviation_bps) = new_max_deviation_bps {
        require!(
            deviation_bps <= MAX_DEVIATION_BPS_CAP,
            VaultError::MaxDeviationTooHigh
        );
    }

    let vault = &mut ctx.accounts.vault;
    let old_oracle = vault.nav_oracle;
    let old_program = vault.oracle_program;

    vault.nav_oracle = new_nav_oracle;
    vault.oracle_program = new_oracle_program;
    vault.max_staleness = new_max_staleness;

    if let Some(deviation_bps) = new_max_deviation_bps {
        vault.max_deviation_bps = deviation_bps;
    }

    emit!(OracleConfigUpdated {
        vault: vault.key(),
        old_oracle,
        new_oracle: new_nav_oracle,
        old_program,
        new_program: new_oracle_program,
        new_max_staleness,
    });

    Ok(())
}

// =============================================================================
// VaultConfig initialization
// =============================================================================

#[derive(Accounts)]
pub struct InitializeVaultConfig<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, CreditVault>,

    #[account(
        init,
        payer = payer,
        space = VaultConfig::LEN,
        seeds = [VAULT_CONFIG_SEED, vault.key().as_ref()],
        bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_vault_config_handler(ctx: Context<InitializeVaultConfig>) -> Result<()> {
    let vault_config = &mut ctx.accounts.vault_config;
    vault_config.vault = ctx.accounts.vault.key();
    vault_config.pending_oracle = Pubkey::default();
    vault_config.oracle_change_at = 0;
    vault_config.compliance_officer = Pubkey::default();
    vault_config.bump = ctx.bumps.vault_config;
    vault_config._reserved = [0u8; 31];

    emit!(VaultConfigInitialized {
        vault: ctx.accounts.vault.key(),
        vault_config: vault_config.key(),
    });

    Ok(())
}

// =============================================================================
// Oracle change timelock: request
// =============================================================================

#[derive(Accounts)]
pub struct RequestOracleChange<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, CreditVault>,

    #[account(
        mut,
        has_one = vault,
        seeds = [VAULT_CONFIG_SEED, vault.key().as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    /// CHECK: Validated as executable below
    pub new_oracle_program_account: UncheckedAccount<'info>,

    pub clock: Sysvar<'info, Clock>,
}

pub fn request_oracle_change_handler(
    ctx: Context<RequestOracleChange>,
    new_oracle: Pubkey,
) -> Result<()> {
    require!(new_oracle != Pubkey::default(), VaultError::InvalidAddress);

    // Validate the new oracle's program is executable
    require!(
        ctx.accounts.new_oracle_program_account.executable,
        VaultError::InvalidOracleProgram
    );

    let vault_config = &mut ctx.accounts.vault_config;
    let change_at = ctx
        .accounts
        .clock
        .unix_timestamp
        .checked_add(ORACLE_TIMELOCK)
        .ok_or(VaultError::MathOverflow)?;

    vault_config.pending_oracle = new_oracle;
    vault_config.oracle_change_at = change_at;

    emit!(OracleChangeRequested {
        vault: ctx.accounts.vault.key(),
        pending_oracle: new_oracle,
        oracle_change_at: change_at,
    });

    Ok(())
}

// =============================================================================
// Oracle change timelock: apply
// =============================================================================

#[derive(Accounts)]
pub struct ApplyOracleChange<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, CreditVault>,

    #[account(
        mut,
        has_one = vault,
        seeds = [VAULT_CONFIG_SEED, vault.key().as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    pub clock: Sysvar<'info, Clock>,
}

pub fn apply_oracle_change_handler(ctx: Context<ApplyOracleChange>) -> Result<()> {
    let vault_config = &ctx.accounts.vault_config;

    require!(
        vault_config.pending_oracle != Pubkey::default(),
        VaultError::OracleChangeNotRequested
    );
    require!(
        ctx.accounts.clock.unix_timestamp >= vault_config.oracle_change_at,
        VaultError::OracleChangeTooEarly
    );

    let old_oracle = ctx.accounts.vault.nav_oracle;
    let new_oracle = vault_config.pending_oracle;

    ctx.accounts.vault.nav_oracle = new_oracle;

    let vault_config = &mut ctx.accounts.vault_config;
    vault_config.pending_oracle = Pubkey::default();
    vault_config.oracle_change_at = 0;

    emit!(OracleChangeApplied {
        vault: ctx.accounts.vault.key(),
        old_oracle,
        new_oracle,
    });

    Ok(())
}

// =============================================================================
// Compliance officer management
// =============================================================================

#[derive(Accounts)]
pub struct SetComplianceOfficer<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, CreditVault>,

    #[account(
        mut,
        has_one = vault,
        seeds = [VAULT_CONFIG_SEED, vault.key().as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,
}

pub fn set_compliance_officer_handler(
    ctx: Context<SetComplianceOfficer>,
    new_officer: Pubkey,
) -> Result<()> {
    require!(new_officer != Pubkey::default(), VaultError::InvalidAddress);

    let vault_config = &mut ctx.accounts.vault_config;
    let old_officer = vault_config.compliance_officer;
    vault_config.compliance_officer = new_officer;

    emit!(ComplianceOfficerUpdated {
        vault: ctx.accounts.vault.key(),
        old_officer,
        new_officer,
    });

    Ok(())
}
