//! Deposit SOL instruction: transfer native SOL to vault, sync wSOL, mint shares to user.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{self, MintTo, Token2022},
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::{MIN_DEPOSIT_AMOUNT, VAULT_SEED},
    error::VaultError,
    events::Deposit as DepositEvent,
    math::{convert_to_shares, Rounding},
    state::Vault, // Importaremos o Vault do SVS-7 adaptado mais tarde
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct DepositSol<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, Vault>,

    /// A conta wSOL do Vault. No SVS-7 ela substitui o "asset_vault" genérico.
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
        init_if_needed,
        payer = user,
        associated_token::mint = shares_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>, // Para o sync_native
    pub token_2022_program: Program<'info, Token2022>, // Para as shares
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>, // Essencial para mover native SOL
}

pub fn handler(ctx: Context<DepositSol>, lamports: u64, min_shares_out: u64) -> Result<()> {
    require!(lamports > 0, VaultError::ZeroAmount);
    require!(lamports >= MIN_DEPOSIT_AMOUNT, VaultError::DepositTooSmall);

    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    
    // Antes da transferência, lemos o balanço de wSOL existente
    let initial_assets = ctx.accounts.wsol_vault.amount;

    // 1. Transferência de native SOL (System Program)
    let cpi_context = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        system_program::Transfer {
            from: ctx.accounts.user.to_account_info(),
            to: ctx.accounts.wsol_vault.to_account_info(), // Mandamos direto para a ATA do Vault
        },
    );
    system_program::transfer(cpi_context, lamports)?;

    // 2. O Segredo do SVS-7: sync_native
    // Isso atualiza o amount interno da conta de token wSOL para refletir os lamports recebidos
    let sync_native_ix = spl_token_2022::instruction::sync_native(
        ctx.accounts.token_program.key,
        ctx.accounts.wsol_vault.key,
    )?;
    anchor_lang::solana_program::program::invoke(
        &sync_native_ix,
        &[ctx.accounts.wsol_vault.to_account_info()],
    )?;

    // 3. Recarrega o estado da conta wSOL para ler o novo amount sincronizado
    ctx.accounts.wsol_vault.reload()?;
    let total_assets_after_sync = ctx.accounts.wsol_vault.amount;
    
    // Safety check implícito: garantimos que o sync funcionou (o saldo total deve incluir o inicial + depósitos via token + lamports recém chegados)
    let effective_deposit = total_assets_after_sync.saturating_sub(initial_assets);
    require!(effective_deposit >= lamports, VaultError::SyncNativeFailed); // Adicionaremos este erro depois

    // O total_assets usado para o cálculo das shares no SVS-7 é o saldo *antes* deste depósito, 
    // ou seja, o initial_assets, pois o novo valor recém depositado não deve diluir a emissão atual.
    
    // ===== Module Hooks (if enabled) =====
    #[cfg(feature = "modules")]
    let net_shares = {
        let remaining = ctx.remaining_accounts;
        let vault_key = vault.key();
        let user_key = ctx.accounts.user.key();

        module_hooks::check_deposit_access(remaining, &crate::ID, &vault_key, &user_key, &[])?;
        module_hooks::check_deposit_caps(remaining, &crate::ID, &vault_key, &user_key, initial_assets, lamports)?;

        let shares = convert_to_shares(
            lamports,
            initial_assets,
            total_shares,
            vault.decimals_offset,
            Rounding::Floor,
        )?;

        let result = module_hooks::apply_entry_fee(remaining, &crate::ID, &vault_key, shares)?;
        result.net_shares
    };

    #[cfg(not(feature = "modules"))]
    let net_shares = {
        convert_to_shares(
            lamports,
            initial_assets,
            total_shares,
            vault.decimals_offset,
            Rounding::Floor,
        )?
    };

    require!(net_shares >= min_shares_out, VaultError::SlippageExceeded);

    // Preparação das seeds do Vault para o CPI de mint
    let asset_mint_key = vault.asset_mint; // wSOL mint no caso do SVS-7
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[bump],
    ]];

    // Mint das shares (Token-2022) para o usuário
    token_2022::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.shares_mint.to_account_info(),
                to: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        net_shares,
    )?;

    emit!(DepositEvent {
        vault: ctx.accounts.vault.key(),
        caller: ctx.accounts.user.key(),
        owner: ctx.accounts.user.key(),
        assets: lamports,
        shares: net_shares,
    });

    Ok(())
}