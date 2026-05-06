use anchor_lang::prelude::*;

use crate::constants::{
    MAX_DEVIATION_BPS_CAP, ORACLE_SOURCE_MOCK, ORACLE_SOURCE_NAV_ORACLE, ORACLE_TIMELOCK,
    VAULT_CONFIG_SEED, VAULT_SEED,
};
use crate::error::VaultError;
use crate::events::{
    AttesterUpdated, AuthorityTransferRequested, AuthorityTransferred, ComplianceOfficerUpdated,
    ManagerChanged, OracleChangeApplied, OracleChangeRequested, OracleConfigUpdated,
    OracleSourceChanged, VaultConfigInitialized, VaultStatusChanged,
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
    pub vault: Box<Account<'info, CreditVault>>,
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

/// Step 1: Request authority transfer. Sets pending_authority; the new authority
/// must call accept_authority to complete the transfer.
pub fn request_transfer_authority_handler(
    ctx: Context<Admin>,
    new_authority: Pubkey,
) -> Result<()> {
    require!(
        new_authority != Pubkey::default(),
        VaultError::InvalidAddress
    );

    let vault = &mut ctx.accounts.vault;

    // V9-P8: Prevent silently overwriting a pending transfer
    require!(
        vault.pending_authority == Pubkey::default(),
        VaultError::PendingTransferExists
    );

    vault.pending_authority = new_authority;

    emit!(AuthorityTransferRequested {
        vault: vault.key(),
        current_authority: vault.authority,
        pending_authority: new_authority,
    });

    Ok(())
}

/// Step 2: Accept authority transfer. Must be signed by the pending authority.
pub fn accept_authority_handler(ctx: Context<AcceptAuthority>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    require!(
        vault.pending_authority != Pubkey::default(),
        VaultError::NoPendingTransfer
    );

    let previous_authority = vault.authority;
    let new_authority = vault.pending_authority;

    vault.authority = new_authority;
    vault.pending_authority = Pubkey::default();

    emit!(AuthorityTransferred {
        vault: vault.key(),
        previous_authority,
        new_authority,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub new_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = vault.pending_authority == new_authority.key() @ VaultError::InvalidPendingAuthority,
    )]
    pub vault: Box<Account<'info, CreditVault>>,
}

/// Transfer vault authority (deprecated -- prefer two-step transfer).
/// V7-P1: Guard against completing single-step transfer while a two-step transfer is pending.
#[allow(deprecated)]
#[deprecated(note = "Use request_transfer_authority + accept_authority two-step pattern")]
pub fn transfer_authority_handler(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
    require!(
        new_authority != Pubkey::default(),
        VaultError::InvalidAddress
    );
    // V7-P1: Prevent bypassing pending two-step transfer via deprecated single-step path
    require!(
        ctx.accounts.vault.pending_authority == Pubkey::default(),
        VaultError::PendingTransferExists
    );

    let previous_authority = ctx.accounts.vault.authority;
    ctx.accounts.vault.authority = new_authority;
    ctx.accounts.vault.pending_authority = Pubkey::default();

    emit!(AuthorityTransferred {
        vault: ctx.accounts.vault.key(),
        previous_authority,
        new_authority,
    });

    Ok(())
}

/// Cancel a pending two-step authority transfer.
/// V7-P4: Dedicated cancel instruction (cleaner than overwriting with a new request).
pub fn cancel_transfer_authority_handler(ctx: Context<Admin>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(
        vault.pending_authority != Pubkey::default(),
        VaultError::NoPendingTransfer
    );

    vault.pending_authority = Pubkey::default();

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
    pub vault: Box<Account<'info, CreditVault>>,

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

/// Deprecated: This instruction bypasses the 24h oracle timelock (C-3 fix).
/// Use `request_oracle_change` + `apply_oracle_change` for oracle address changes,
/// and `update_oracle_params` for staleness/deviation settings.
#[derive(Accounts)]
pub struct UpdateOracleConfig<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, CreditVault>>,

    /// CHECK: No longer used; kept for IDL backwards compatibility.
    pub new_oracle_program_account: UncheckedAccount<'info>,
}

/// Deprecated: always returns `OracleConfigDeprecated` error.
/// Oracle address/program changes must go through the timelock flow
/// (`request_oracle_change` + `apply_oracle_change`).
/// Staleness and deviation settings use `update_oracle_params`.
#[deprecated(
    note = "Bypasses oracle timelock. Use request_oracle_change + apply_oracle_change, or update_oracle_params."
)]
pub fn update_oracle_config_handler(
    _ctx: Context<UpdateOracleConfig>,
    _new_nav_oracle: Pubkey,
    _new_oracle_program: Pubkey,
    _new_max_staleness: i64,
    _new_max_deviation_bps: Option<u16>,
) -> Result<()> {
    err!(VaultError::OracleConfigDeprecated)
}

// =============================================================================
// Oracle non-address parameter updates (no timelock required)
// =============================================================================

#[derive(Accounts)]
pub struct UpdateOracleParams<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, CreditVault>>,
}

/// Update non-address oracle parameters (max_staleness, max_deviation_bps).
/// Oracle address and program changes must use the timelock flow.
pub fn update_oracle_params_handler(
    ctx: Context<UpdateOracleParams>,
    new_max_staleness: Option<i64>,
    new_max_deviation_bps: Option<u16>,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    if let Some(staleness) = new_max_staleness {
        require!(
            (60..=86400).contains(&staleness),
            VaultError::InvalidStalenessConfig
        );
        vault.max_staleness = staleness;
    }

    if let Some(deviation_bps) = new_max_deviation_bps {
        require!(
            deviation_bps <= MAX_DEVIATION_BPS_CAP,
            VaultError::MaxDeviationTooHigh
        );
        vault.max_deviation_bps = deviation_bps;
    }

    emit!(OracleConfigUpdated {
        vault: vault.key(),
        old_oracle: vault.nav_oracle,
        new_oracle: vault.nav_oracle,
        old_program: vault.oracle_program,
        new_program: vault.oracle_program,
        new_max_staleness: vault.max_staleness,
    });

    Ok(())
}

/// Switch the vault's oracle read path between the simple/mock oracle path
/// (`0`) and the optional NavOracle adapter (`1`). This is deliberately
/// separate from oracle address changes: it does not mutate `nav_oracle` or
/// `oracle_program`, so deployments can opt into or out of richer NAV reads
/// without a full program upgrade.
pub fn set_oracle_source_handler(ctx: Context<UpdateOracleParams>, source: u8) -> Result<()> {
    require!(
        source == ORACLE_SOURCE_MOCK || source == ORACLE_SOURCE_NAV_ORACLE,
        VaultError::OracleSourceInvalid
    );

    let vault = &mut ctx.accounts.vault;
    let old_source = vault.oracle_source;
    vault.oracle_source = source;

    emit!(OracleSourceChanged {
        vault: vault.key(),
        old_source,
        new_source: source,
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
    pub vault: Box<Account<'info, CreditVault>>,

    #[account(
        init,
        payer = payer,
        space = VaultConfig::LEN,
        seeds = [VAULT_CONFIG_SEED, vault.key().as_ref()],
        bump,
    )]
    pub vault_config: Box<Account<'info, VaultConfig>>,

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
    pub vault: Box<Account<'info, CreditVault>>,

    #[account(
        mut,
        has_one = vault,
        seeds = [VAULT_CONFIG_SEED, vault.key().as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Box<Account<'info, VaultConfig>>,

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
    pub vault: Box<Account<'info, CreditVault>>,

    #[account(
        mut,
        has_one = vault,
        seeds = [VAULT_CONFIG_SEED, vault.key().as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Box<Account<'info, VaultConfig>>,

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
    pub vault: Box<Account<'info, CreditVault>>,

    #[account(
        mut,
        has_one = vault,
        seeds = [VAULT_CONFIG_SEED, vault.key().as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Box<Account<'info, VaultConfig>>,
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
