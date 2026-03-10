//! Withdraw SOL instruction: burn shares, unwrap wSOL, transfer native SOL to user.

use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::{self, Burn, Token2022},
    token_interface::{self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    constants::VAULT_SEED,
    error::VaultError,
    events::Withdraw as WithdrawEvent,
    math::{convert_to_assets, Rounding},
    state::Vault,
};

#[derive(Accounts)]
pub struct WithdrawSol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        constraint = wsol_vault.key() == vault.asset_vault,
    )]
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_shares_account.owner == user.key(),
        constraint = user_shares_account.mint == vault.shares_mint,
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    /// Conta temporária de wSOL para o unwrap. 
    /// Deve ser inicializada pelo cliente ou via CPI antes do close_account.
    #[account(mut)]
    pub temp_wsol_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<WithdrawSol>, assets: u64, max_shares_in: u64) -> Result<()> {
    require!(assets > 0, VaultError::ZeroAmount);

    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = ctx.accounts.wsol_vault.amount;

    // Calcular shares necessárias (Ceil para favorecer o cofre)
    let shares = convert_to_assets(
        assets,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Ceil,
    )?;

    require!(shares <= max_shares_in, VaultError::SlippageExceeded);

    // 1. Burn das shares do usuário
    token_2022::burn(
        CpiContext::new(
            ctx.accounts.token_2022_program.to_account_info(),
            Burn {
                mint: ctx.accounts.shares_mint.to_account_info(),
                from: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        shares,
    )?;

    // Preparar seeds para assinar como Vault
    let asset_mint_key = vault.asset_mint;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[bump],
    ]];

    // 2. Transferir wSOL para a conta temporária
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.wsol_vault.to_account_info(),
                to: ctx.accounts.temp_wsol_account.to_account_info(),
                mint: ctx.accounts.vault.asset_mint.to_account_info(), // Assumindo wSOL mint aqui
                authority: vault.to_account_info(),
            },
            signer_seeds,
        ),
        assets,
        9, // SOL decimals
    )?;

    // 3. Fechar a conta temporária (Unwrap automático para SOL nativo enviado ao usuário)
    token_interface::close_account(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.temp_wsol_account.to_account_info(),
                destination: ctx.accounts.user.to_account_info(),
                authority: vault.to_account_info(),
            },
            signer_seeds,
        ),
    )?;

    emit!(WithdrawEvent {
        vault: vault.key(),
        caller: ctx.accounts.user.key(),
        receiver: ctx.accounts.user.key(),
        owner: ctx.accounts.user.key(),
        assets,
        shares,
    });

    Ok(())
}