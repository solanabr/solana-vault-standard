use anchor_lang::prelude::*;

use crate::constants::VAULT_SEED;
use crate::error::VaultError;
use crate::events::{
    AttesterUpdated, AuthorityTransferred, ManagerChanged, OracleConfigUpdated, VaultStatusChanged,
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

pub fn update_attester_handler(
    ctx: Context<Admin>,
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
        new_max_staleness >= 60 && new_max_staleness <= 86400,
        VaultError::InvalidStalenessConfig
    );

    let vault = &mut ctx.accounts.vault;
    let old_oracle = vault.nav_oracle;
    let old_program = vault.oracle_program;

    vault.nav_oracle = new_nav_oracle;
    vault.oracle_program = new_oracle_program;
    vault.max_staleness = new_max_staleness;

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
