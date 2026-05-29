use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_2022::spl_token_2022::extension::{
    transfer_hook::TransferHook, BaseStateWithExtensions, StateWithExtensions,
};
use anchor_spl::token_2022::spl_token_2022::state::Mint as Token2022Mint;
use anchor_spl::token_interface::{mint_to, Mint, MintTo, TokenAccount, TokenInterface};
use spl_transfer_hook_interface::onchain::add_extra_accounts_for_execute_cpi;

use crate::error::DeRwaError;
use crate::state::WrapperConfig;

fn read_hook_program_id(mint: &AccountInfo) -> Result<Option<Pubkey>> {
    if mint.owner != &spl_token_2022::ID {
        return Ok(None);
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<Token2022Mint>::unpack(&data)
        .map_err(|_| error!(DeRwaError::MintMismatch))?;
    match state.get_extension::<TransferHook>() {
        Ok(ext) => Ok(Option::<Pubkey>::from(ext.program_id)),
        Err(_) => Ok(None),
    }
}

/// Wrap permissioned cPOOL → freely-transferable dePOOL at 1:1. Maintains
/// `locked_supply == dePOOL.supply`. The cPOOL transfer fires the
/// ComplianceHook; callers must supply the resolved EAML extras in
/// `remaining_accounts` (handled by the SDK's `DeRwaWrapper.wrap` helper).
#[derive(Accounts)]
pub struct Wrap<'info> {
    #[account(
        mut,
        seeds = [WrapperConfig::SEED_PREFIX, wrapper_config.pool.as_ref()],
        bump = wrapper_config.bump,
        constraint = wrapper_config.permissioned_mint == permissioned_mint.key() @ DeRwaError::MintMismatch,
        constraint = wrapper_config.derwa_mint == derwa_mint.key() @ DeRwaError::MintMismatch,
    )]
    pub wrapper_config: Box<Account<'info, WrapperConfig>>,

    /// CHECK: PDA owning the locked cPOOL ATA + dePOOL mint authority.
    #[account(
        seeds = [b"wrapper_signer", wrapper_config.pool.as_ref()],
        bump,
    )]
    pub wrapper_signer: UncheckedAccount<'info>,

    #[account(mut)]
    pub permissioned_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub derwa_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = permissioned_mint,
        token::authority = investor,
    )]
    pub investor_permissioned_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = permissioned_mint,
        associated_token::authority = wrapper_signer,
        associated_token::token_program = token_program,
    )]
    pub wrapper_locked_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = derwa_mint,
        token::authority = investor,
    )]
    pub investor_derwa_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub investor: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler<'info>(ctx: Context<'_, '_, '_, 'info, Wrap<'info>>, amount: u64) -> Result<()> {
    require!(amount > 0, DeRwaError::ZeroAmount);

    let mut transfer_ix = spl_token_2022::instruction::transfer_checked(
        &spl_token_2022::ID,
        &ctx.accounts.investor_permissioned_ata.key(),
        &ctx.accounts.permissioned_mint.key(),
        &ctx.accounts.wrapper_locked_ata.key(),
        &ctx.accounts.investor.key(),
        &[],
        amount,
        ctx.accounts.permissioned_mint.decimals,
    )?;
    let mut transfer_account_infos: Vec<AccountInfo<'info>> = vec![
        ctx.accounts.investor_permissioned_ata.to_account_info(),
        ctx.accounts.permissioned_mint.to_account_info(),
        ctx.accounts.wrapper_locked_ata.to_account_info(),
        ctx.accounts.investor.to_account_info(),
    ];
    if let Some(hook_program_id) =
        read_hook_program_id(&ctx.accounts.permissioned_mint.to_account_info())?
    {
        add_extra_accounts_for_execute_cpi(
            &mut transfer_ix,
            &mut transfer_account_infos,
            &hook_program_id,
            ctx.accounts.investor_permissioned_ata.to_account_info(),
            ctx.accounts.permissioned_mint.to_account_info(),
            ctx.accounts.wrapper_locked_ata.to_account_info(),
            ctx.accounts.investor.to_account_info(),
            amount,
            ctx.remaining_accounts,
        )
        .map_err(|e| -> Error { e.into() })?;
    }
    invoke_signed(&transfer_ix, &transfer_account_infos, &[])?;

    let pool_key = ctx.accounts.wrapper_config.pool;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"wrapper_signer",
        pool_key.as_ref(),
        &[ctx.bumps.wrapper_signer],
    ]];
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        MintTo {
            mint: ctx.accounts.derwa_mint.to_account_info(),
            to: ctx.accounts.investor_derwa_ata.to_account_info(),
            authority: ctx.accounts.wrapper_signer.to_account_info(),
        },
        signer_seeds,
    );
    mint_to(cpi_ctx, amount)?;

    let cfg = &mut ctx.accounts.wrapper_config;
    cfg.locked_supply = cfg
        .locked_supply
        .checked_add(amount)
        .ok_or(DeRwaError::LockedSupplyOverflow)?;

    emit!(crate::events::Wrapped {
        pool: cfg.pool,
        investor: ctx.accounts.investor.key(),
        amount,
        locked_supply_after: cfg.locked_supply,
    });
    Ok(())
}
