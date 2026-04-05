//! Admin instructions: pause, unpause, sync, transfer authority, collect fees.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    constants::VAULT_SEED,
    error::VaultError,
    events::{
        AuthorityTransferRequested, AuthorityTransferred, FeeRecipientUpdated, FeesCollected,
        TotalAssetsDecreased, VaultStatusChanged, VaultSynced,
    },
    state::Vault,
};

#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,
}

/// V9-P4: Add PDA seeds validation for consistency with SVS-3/4.
#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub new_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [crate::constants::VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = vault.pending_authority == new_authority.key() @ VaultError::InvalidPendingAuthority,
    )]
    pub vault: Box<Account<'info, Vault>>,
}

#[derive(Accounts)]
pub struct Sync<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        constraint = asset_vault.key() == vault.asset_vault,
    )]
    pub asset_vault: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[derive(Accounts)]
pub struct CollectFees<'info> {
    #[account(
        mut,
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
        constraint = vault.fee_recipient != Pubkey::default() @ VaultError::FeeRecipientNotSet,
    )]
    pub vault: Box<Account<'info, Vault>>,

    pub authority: Signer<'info>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint,
    )]
    pub asset_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        constraint = asset_vault.key() == vault.asset_vault,
    )]
    pub asset_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Fee recipient token account — must match the vault's stored fee_recipient address
    #[account(
        mut,
        constraint = fee_recipient.key() == vault.fee_recipient @ VaultError::InvalidFeeRecipient,
        constraint = fee_recipient.mint == vault.asset_mint,
    )]
    pub fee_recipient: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SetFeeRecipient<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub vault: Box<Account<'info, Vault>>,
}

/// Pause all vault operations (emergency circuit breaker)
pub fn pause(ctx: Context<Admin>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    require!(!vault.paused, VaultError::VaultPaused);

    vault.paused = true;

    emit!(VaultStatusChanged {
        vault: vault.key(),
        paused: true,
    });

    Ok(())
}

/// Unpause vault operations
pub fn unpause(ctx: Context<Admin>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    require!(vault.paused, VaultError::VaultNotPaused);

    vault.paused = false;

    emit!(VaultStatusChanged {
        vault: vault.key(),
        paused: false,
    });

    Ok(())
}

/// Step 1: Request authority transfer. Sets pending_authority; the new authority
/// must call accept_authority to complete the transfer.
pub fn request_transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
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
pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
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

/// Direct transfer authority (deprecated — prefer request_transfer_authority + accept_authority)
pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
    require!(
        new_authority != Pubkey::default(),
        VaultError::InvalidAddress
    );

    let vault = &mut ctx.accounts.vault;

    // V5-P3: Prevent silently overwriting a pending two-step transfer
    require!(
        vault.pending_authority == Pubkey::default(),
        VaultError::PendingTransferExists
    );

    let previous_authority = vault.authority;

    vault.authority = new_authority;
    vault.pending_authority = Pubkey::default();

    emit!(AuthorityTransferred {
        vault: vault.key(),
        previous_authority,
        new_authority,
    });

    Ok(())
}

/// Cancel a pending two-step authority transfer.
pub fn cancel_transfer_authority(ctx: Context<Admin>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(
        vault.pending_authority != Pubkey::default(),
        VaultError::NoPendingTransfer
    );

    vault.pending_authority = Pubkey::default();

    Ok(())
}

/// Sync total_assets with actual vault balance.
/// Used when rewards/donations are sent directly to the vault.
/// Emits a TotalAssetsDecreased event if the new balance is lower than the
/// previous total_assets to provide an auditable record of any decrease
/// (which could dilute existing shareholders).
///
/// V9-P5: Operational note — call `collect_fees` BEFORE `sync` if exit fees have
/// accumulated. Sync sets total_assets = actual_balance which includes uncollected
/// fees. Collecting fees after sync is safe (capped at min(cumulative, total_assets))
/// but changes the effective assets-per-share ratio.
pub fn sync(ctx: Context<Sync>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let previous_total = vault.total_assets;
    let actual_balance = ctx.accounts.asset_vault.amount;

    if actual_balance < previous_total {
        emit!(TotalAssetsDecreased {
            vault: vault.key(),
            previous_total,
            new_total: actual_balance,
        });
    }

    vault.total_assets = actual_balance;

    emit!(VaultSynced {
        vault: vault.key(),
        previous_total,
        new_total: actual_balance,
    });

    Ok(())
}

/// Withdraw accumulated exit fees from the vault.
///
/// V4-P14 FIX: If total_assets has been depressed (e.g. by sync() reflecting an
/// external loss), cumulative_exit_fees may exceed total_assets. Rather than
/// underflowing and permanently bricking fee collection, we cap the collectible
/// amount to min(cumulative_exit_fees, total_assets). Any remainder stays in
/// cumulative_exit_fees and can be collected once total_assets recovers.
pub fn collect_fees(ctx: Context<CollectFees>) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let cumulative = vault.cumulative_exit_fees;

    require!(cumulative > 0, VaultError::NoFeesToCollect);

    // Cap to available total_assets to prevent underflow when sync() has
    // depressed the balance below cumulative fees owed.
    let fee_amount = cumulative.min(vault.total_assets);
    require!(fee_amount > 0, VaultError::NoFeesToCollect);

    // Transfer fees from asset vault to fee recipient using PDA signer
    let asset_mint_key = vault.asset_mint;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[bump],
    ]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.asset_vault.to_account_info(),
                to: ctx.accounts.fee_recipient.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        fee_amount,
        ctx.accounts.asset_mint.decimals,
    )?;

    // Fees leave the vault, so decrement total_assets
    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault
        .total_assets
        .checked_sub(fee_amount)
        .ok_or(VaultError::MathOverflow)?;
    // Only subtract the actually collected amount; remainder stays for future collection
    vault.cumulative_exit_fees = cumulative
        .checked_sub(fee_amount)
        .ok_or(VaultError::MathOverflow)?;

    emit!(FeesCollected {
        vault: vault.key(),
        authority: ctx.accounts.authority.key(),
        fee_recipient: ctx.accounts.fee_recipient.key(),
        amount: fee_amount,
    });

    Ok(())
}

/// Set or update the designated fee recipient for the vault.
/// Only the vault authority can call this.
pub fn set_fee_recipient(ctx: Context<SetFeeRecipient>, new_fee_recipient: Pubkey) -> Result<()> {
    require!(
        new_fee_recipient != Pubkey::default(),
        VaultError::InvalidAddress
    );

    let vault = &mut ctx.accounts.vault;
    let previous = vault.fee_recipient;
    vault.fee_recipient = new_fee_recipient;

    emit!(FeeRecipientUpdated {
        vault: vault.key(),
        previous_recipient: previous,
        new_recipient: new_fee_recipient,
    });

    Ok(())
}
