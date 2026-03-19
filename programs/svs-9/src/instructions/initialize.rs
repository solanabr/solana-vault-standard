use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use anchor_spl::token_2022::Token2022;
use anchor_spl::associated_token::AssociatedToken;
use crate::state::*;
use crate::constants::*;
use crate::events::*;
use crate::error::*;

#[derive(Accounts)]
#[instruction(vault_id: u64, idle_buffer_bps: u16, decimals_offset: u8)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Curator doesn't need to be a signer, just a pubkey for configuration
    pub curator: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + AllocatorVault::INIT_SPACE,
        seeds = [ALLOCATOR_VAULT_SEED, asset_mint.key().as_ref(), &vault_id.to_le_bytes()],
        bump
    )]
    pub allocator_vault: Account<'info, AllocatorVault>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// Shares mint for SVS-9 (always Token-2022)
    #[account(
        init,
        payer = authority,
        mint::decimals = asset_mint.decimals,
        mint::authority = allocator_vault,
        mint::token_program = token_2022_program,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    /// The idle vault is an ATA owned by the allocator_vault to hold unallocated assets
    #[account(
        init,
        payer = authority,
        associated_token::mint = asset_mint,
        associated_token::authority = allocator_vault,
        associated_token::token_program = token_program,
    )]
    pub idle_vault: InterfaceAccount<'info, TokenAccount>,

    /// Token program for asset (can be SPL Token or Token-2022)
    pub token_program: Interface<'info, TokenInterface>,
    
    /// Token program for shares (must be Token-2022)
    pub token_2022_program: Program<'info, Token2022>,
    
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_handler(ctx: Context<Initialize>, vault_id: u64, idle_buffer_bps: u16, decimals_offset: u8) -> Result<()> {
    // 1. VALIDATION
    require!(idle_buffer_bps <= 10000, VaultError::MathOverflow);
    // decimals_offset must be 0–9 (virtual precision can't exceed 9 decimals)
    require!(decimals_offset <= 9, VaultError::MathOverflow);
    
    // 2. READ STATE
    // (None for initialization)
    
    // 3. COMPUTE
    // (None for initialization)
    
    // 4. SLIPPAGE CHECK
    // (None for initialization)
    
    // 5. EXECUTE CPIs
    // (Handled by Anchor accounts initialization)

    // 6. UPDATE STATE
    let vault = &mut ctx.accounts.allocator_vault;
    vault.authority = ctx.accounts.authority.key();
    vault.curator = ctx.accounts.curator.key();
    vault.asset_mint = ctx.accounts.asset_mint.key();
    vault.shares_mint = ctx.accounts.shares_mint.key();
    vault.idle_vault = ctx.accounts.idle_vault.key();
    vault.total_shares = 0;
    vault.num_children = 0;
    vault.idle_buffer_bps = idle_buffer_bps;
    vault.decimals_offset = decimals_offset;
    vault.bump = ctx.bumps.allocator_vault;
    vault.paused = false;
    vault.vault_id = vault_id;
    vault._reserved = [0u8; 64];

    // 7. EMIT EVENT
    let virtual_shares = 10u128.pow(decimals_offset as u32);
    let virtual_assets = 1u128; // Protection against inflation attacks

    emit!(VaultInitializedEvent {
        vault: vault.key(),
        asset_mint: vault.asset_mint,
        authority: vault.authority,
        curator: vault.curator,
        decimals_offset,
        virtual_shares,
        virtual_assets,
    });

    Ok(())
}
