use anchor_lang::prelude::*;
use anchor_spl::{associated_token::AssociatedToken, token_2022::Token2022, token_interface::{Mint, TokenAccount, TokenInterface}};
use crate::{constants::{ALLOCATOR_SEED, IDLE_VAULT_SEED, MAX_IDLE_BUFFER_BPS}, error::AllocatorError, events::AllocatorInitialized, state::AllocatorVault};

pub fn handler(ctx: Context<Initialize>, vault_id: u64, _name: String, _symbol: String, _uri: String, idle_buffer_bps: u16) -> Result<()> {
    require!(idle_buffer_bps < MAX_IDLE_BUFFER_BPS, AllocatorError::InvalidIdleBuffer);
    require!(ctx.accounts.asset_mint.decimals <= 9, AllocatorError::InvalidAssetDecimals);
    let decimals_offset = 9u8.saturating_sub(ctx.accounts.asset_mint.decimals);
    let vault = &mut ctx.accounts.allocator_vault;
    vault.authority = ctx.accounts.authority.key();
    vault.curator = ctx.accounts.authority.key();
    vault.asset_mint = ctx.accounts.asset_mint.key();
    vault.shares_mint = ctx.accounts.shares_mint.key();
    vault.idle_vault = ctx.accounts.idle_vault.key();
    vault.decimals_offset = decimals_offset;
    vault.bump = ctx.bumps.allocator_vault;
    vault.paused = false;
    vault.vault_id = vault_id;
    vault.num_children = 0;
    vault.idle_buffer_bps = idle_buffer_bps;
    vault._reserved = [0u8; 64];
    emit!(AllocatorInitialized { vault: vault.key(), authority: ctx.accounts.authority.key(), curator: ctx.accounts.authority.key(), asset_mint: ctx.accounts.asset_mint.key(), shares_mint: ctx.accounts.shares_mint.key(), idle_vault: ctx.accounts.idle_vault.key(), vault_id, idle_buffer_bps });
    Ok(())
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct Initialize<'info> {
    #[account(mut)] pub authority: Signer<'info>,
    #[account(init, payer = authority, space = AllocatorVault::LEN, seeds = [ALLOCATOR_SEED, asset_mint.key().as_ref(), &vault_id.to_le_bytes()], bump)] pub allocator_vault: Account<'info, AllocatorVault>,
    pub asset_mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = authority, seeds = [b"shares", allocator_vault.key().as_ref()], bump, mint::decimals = 9, mint::authority = allocator_vault, mint::freeze_authority = allocator_vault, mint::token_program = token_2022_program)] pub shares_mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = authority, seeds = [IDLE_VAULT_SEED, allocator_vault.key().as_ref()], bump, token::mint = asset_mint, token::authority = allocator_vault, token::token_program = asset_token_program)] pub idle_vault: InterfaceAccount<'info, TokenAccount>,
    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
