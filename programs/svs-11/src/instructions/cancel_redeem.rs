use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_2022::spl_token_2022::extension::{
    transfer_hook::TransferHook, BaseStateWithExtensions, StateWithExtensions,
};
use anchor_spl::token_2022::spl_token_2022::state::Mint as Token2022Mint;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{
    close_account, CloseAccount, Mint, TokenAccount, TokenInterface,
};
use spl_transfer_hook_interface::onchain::add_extra_accounts_for_execute_cpi;

use crate::constants::{
    CLAIMABLE_TOKENS_SEED, FROZEN_ACCOUNT_SEED, REDEMPTION_ESCROW_SEED, REDEMPTION_REQUEST_SEED,
    SHARES_DECIMALS, VAULT_SEED,
};
use crate::error::VaultError;
use crate::events::RedemptionCancelled;
use crate::state::{CreditVault, RedemptionRequest, RequestStatus};

fn read_hook_program_id(mint: &AccountInfo) -> Result<Option<Pubkey>> {
    if mint.owner != &spl_token_2022::ID {
        return Ok(None);
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<Token2022Mint>::unpack(&data)
        .map_err(|_| error!(VaultError::InvalidMintAccount))?;
    match state.get_extension::<TransferHook>() {
        Ok(ext) => Ok(Option::<Pubkey>::from(ext.program_id)),
        Err(_) => Ok(None),
    }
}

#[derive(Accounts)]
pub struct CancelRedeem<'info> {
    #[account(mut)]
    pub investor: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, CreditVault>>,

    #[account(
        mut,
        close = investor,
        has_one = vault,
        seeds = [REDEMPTION_REQUEST_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump = redemption_request.bump,
        constraint = redemption_request.status == RequestStatus::Pending @ VaultError::RequestNotPending,
        constraint = redemption_request.assets_claimable == 0 @ VaultError::RequestPartiallyFulfilled,
        constraint = investor.key() == redemption_request.investor,
    )]
    pub redemption_request: Box<Account<'info, RedemptionRequest>>,

    #[account(constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(constraint = asset_mint.key() == vault.asset_mint)]
    pub asset_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Empty (guarded by `assets_claimable == 0` above); closed to refund rent.
    #[account(
        mut,
        seeds = [CLAIMABLE_TOKENS_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump,
        constraint = claimable_tokens.mint == vault.asset_mint @ VaultError::InvalidMintAccount,
        constraint = claimable_tokens.owner == vault.key() @ VaultError::Unauthorized,
    )]
    pub claimable_tokens: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = investor_shares_account.mint == vault.shares_mint,
        constraint = investor_shares_account.owner == investor.key(),
    )]
    pub investor_shares_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [REDEMPTION_ESCROW_SEED, vault.key().as_ref()],
        bump = vault.redemption_escrow_bump,
    )]
    pub redemption_escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: If data is non-empty, investor is frozen
    #[account(
        seeds = [FROZEN_ACCOUNT_SEED, vault.key().as_ref(), investor.key().as_ref()],
        bump,
    )]
    pub frozen_check: UncheckedAccount<'info>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(ctx: Context<'_, '_, '_, 'info, CancelRedeem<'info>>) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    require!(
        ctx.accounts.frozen_check.data_is_empty(),
        VaultError::AccountFrozen
    );

    let vault = &mut ctx.accounts.vault;
    vault.total_pending_redeems = vault
        .total_pending_redeems
        .checked_sub(1)
        .ok_or(VaultError::MathOverflow)?;

    let shares_to_return = ctx.accounts.redemption_request.shares_locked;

    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let vault_bump_bytes = [ctx.accounts.vault.bump];
    let vault_seeds: &[&[u8]] = &[
        VAULT_SEED,
        asset_mint_key.as_ref(),
        &vault_id_bytes,
        &vault_bump_bytes,
    ];

    let mut transfer_ix = spl_token_2022::instruction::transfer_checked(
        &spl_token_2022::ID,
        &ctx.accounts.redemption_escrow.key(),
        &ctx.accounts.shares_mint.key(),
        &ctx.accounts.investor_shares_account.key(),
        &ctx.accounts.vault.key(),
        &[],
        shares_to_return,
        SHARES_DECIMALS,
    )?;
    let mut transfer_account_infos: Vec<AccountInfo<'info>> = vec![
        ctx.accounts.redemption_escrow.to_account_info(),
        ctx.accounts.shares_mint.to_account_info(),
        ctx.accounts.investor_shares_account.to_account_info(),
        ctx.accounts.vault.to_account_info(),
    ];
    if let Some(hook_program_id) =
        read_hook_program_id(&ctx.accounts.shares_mint.to_account_info())?
    {
        add_extra_accounts_for_execute_cpi(
            &mut transfer_ix,
            &mut transfer_account_infos,
            &hook_program_id,
            ctx.accounts.redemption_escrow.to_account_info(),
            ctx.accounts.shares_mint.to_account_info(),
            ctx.accounts.investor_shares_account.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            shares_to_return,
            ctx.remaining_accounts,
        )
        .map_err(|_| -> Error { error!(VaultError::HookExtrasMismatch) })?;
    }
    invoke_signed(&transfer_ix, &transfer_account_infos, &[vault_seeds])?;

    close_account(CpiContext::new_with_signer(
        ctx.accounts.asset_token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.claimable_tokens.to_account_info(),
            destination: ctx.accounts.investor.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        &[vault_seeds],
    ))?;

    emit!(RedemptionCancelled {
        vault: ctx.accounts.vault.key(),
        investor: ctx.accounts.investor.key(),
        shares: shares_to_return,
    });

    Ok(())
}
