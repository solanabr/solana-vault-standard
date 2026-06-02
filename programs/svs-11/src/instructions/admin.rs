use anchor_lang::prelude::*;

use crate::constants::{DEFAULT_MAX_NAV_STALENESS_SECS, VAULT_SEED};
use crate::error::VaultError;
use crate::events::{
    AttesterUpdated, AuthorityTransferRequested, AuthorityTransferred, ManagerChanged,
    OracleChanged, OracleConfigUpdated, VaultStatusChanged,
};
use crate::state::CreditVault;

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

    // Prevent silently overwriting a pending transfer
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
/// Guard against completing single-step transfer while a two-step transfer is pending.
#[allow(deprecated)]
#[deprecated(note = "Use request_transfer_authority + accept_authority two-step pattern")]
pub fn transfer_authority_handler(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
    require!(
        new_authority != Pubkey::default(),
        VaultError::InvalidAddress
    );
    // Prevent bypassing pending two-step transfer via deprecated single-step path
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
/// Dedicated cancel instruction (cleaner than overwriting with a new request).
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

// =============================================================================
// Oracle non-address parameter updates
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

/// Update the non-address oracle staleness window. Oracle address and program
/// changes use `set_oracle`; per-oracle integrity (e.g. price deviation) lives
/// in the oracle program, not the vault.
pub fn update_oracle_params_handler(
    ctx: Context<UpdateOracleParams>,
    new_max_staleness: Option<i64>,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    if let Some(staleness) = new_max_staleness {
        // Ceiling is the NAV staleness window (45 days), not 24h — `max_staleness`
        // is the single oracle staleness config after the mock/nav collapse.
        require!(
            (60..=DEFAULT_MAX_NAV_STALENESS_SECS).contains(&staleness),
            VaultError::InvalidStalenessConfig
        );
        vault.max_staleness = staleness;
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

// =============================================================================
// Oracle rotation: authority-gated, atomic (oracle account + owner program)
// =============================================================================

#[derive(Accounts)]
pub struct SetOracle<'info> {
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

    /// CHECK: validated against the `new_oracle_program` arg + executable below.
    pub new_oracle_program_account: UncheckedAccount<'info>,

    /// CHECK: validated against the `new_oracle` arg + owner == program below.
    pub new_oracle_account: UncheckedAccount<'info>,
}

/// Repoint the vault's NAV oracle (authority-gated). Atomically swaps the oracle
/// account and its owner program. Fail-fast, fail-closed.
pub fn set_oracle_handler(
    ctx: Context<SetOracle>,
    new_oracle: Pubkey,
    new_oracle_program: Pubkey,
) -> Result<()> {
    require!(
        ctx.accounts.new_oracle_program_account.key() == new_oracle_program,
        VaultError::InvalidAddress
    );
    require!(
        ctx.accounts.new_oracle_program_account.executable,
        VaultError::OracleInvalidProgram
    );
    require!(
        ctx.accounts.new_oracle_account.key() == new_oracle,
        VaultError::InvalidAddress
    );
    require!(
        ctx.accounts.new_oracle_account.owner == &new_oracle_program,
        VaultError::OracleInvalidProgram
    );

    let old_oracle = ctx.accounts.vault.nav_oracle;
    let old_program = ctx.accounts.vault.oracle_program;

    // Fail-fast: require a readable, version-compatible header (NOT freshness —
    // a valid oracle may be stale/unpublished at rotation). Seed the replay
    // floor from the incoming sequence (0 if unpublished) so a fresh oracle
    // isn't bricked and a swap-back can't replay an older NAV.
    let incoming_sequence = {
        let data = ctx.accounts.new_oracle_account.try_borrow_data()?;
        let header = svs_oracle::SvsOraclePrice::from_account_data(&data)
            .map_err(|_| error!(VaultError::OracleInvalidProgram))?;
        require!(
            header.version == svs_oracle::SVS_ORACLE_VERSION,
            VaultError::OracleInvalidProgram
        );
        header.sequence
    };

    let vault = &mut ctx.accounts.vault;
    vault.nav_oracle = new_oracle;
    vault.oracle_program = new_oracle_program;
    vault.last_seen_nav_sequence = incoming_sequence;

    emit!(OracleChanged {
        vault: vault.key(),
        old_oracle,
        new_oracle,
        old_program,
        new_program: new_oracle_program,
        authority: ctx.accounts.authority.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
