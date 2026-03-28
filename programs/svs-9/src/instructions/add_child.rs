use crate::constants::*;
use crate::error::*;
use crate::events::*;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

#[derive(Accounts)]
pub struct AddChild<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority,
        constraint = allocator_vault.num_children < 10 @ VaultError::MathOverflow,
    )]
    pub allocator_vault: Account<'info, AllocatorVault>,

    #[account(
        init,
        payer = authority,
        space = 8 + ChildAllocation::INIT_SPACE,
        seeds = [CHILD_ALLOCATION_SEED, allocator_vault.key().as_ref(), child_vault.key().as_ref()],
        bump
    )]
    pub child_allocation: Account<'info, ChildAllocation>,

    /// CHECK: Public key of the vault being added as a child.
    #[account(
        constraint = child_vault.owner == &child_program.key() @ VaultError::InvalidChildProgram
    )]
    pub child_vault: UncheckedAccount<'info>,

    /// CHECK: The program that owns the child vault. Stored for CPI verification.
    // SVS-5 (streaming yield) is currently Status: Draft and has no deployed program ID.
    // Add SVS5_ID here once the program is deployed.
    #[account(
        executable,
        constraint = [SVS1_ID, SVS2_ID, SVS3_ID, SVS4_ID, SVS9_ID].contains(&child_program.key()) @ VaultError::InvalidChildProgram
    )]
    pub child_program: UncheckedAccount<'info>,

    /// Shares mint of the child vault being added
    pub child_shares_mint: InterfaceAccount<'info, Mint>,

    /// ATA for the allocator to hold shares in the child vault
    #[account(
        init,
        payer = authority,
        associated_token::mint = child_shares_mint,
        associated_token::authority = allocator_vault,
        associated_token::token_program = token_2022_program,
    )]
    pub allocator_child_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn add_child_handler(ctx: Context<AddChild>, max_weight_bps: u16) -> Result<()> {
    // 1. VALIDATION
    // Max weight cannot exceed 100% (10,000 bps)
    require!(max_weight_bps <= 10000, VaultError::MathOverflow);

    // Validate child_vault discriminator and compute decimals_offset from vault state
    let vault_data = ctx.accounts.child_vault.try_borrow_data()?;
    require!(vault_data.len() >= 8, VaultError::InvalidChildVault);
    let discriminator = &vault_data[0..8];
    require!(
        discriminator == VAULT_DISCRIMINATOR
            || discriminator == CONFIDENTIAL_VAULT_DISCRIMINATOR
            || discriminator == ALLOCATOR_VAULT_DISCRIMINATOR,
        VaultError::InvalidChildVault
    );

    // Read decimals_offset from the child vault state rather than accepting user input.
    // SVS-1/2/3/4 (standard + confidential): discriminator(8) + authority(32) + asset_mint(32)
    //   + shares_mint(32) + asset_vault(32) = byte 136
    // SVS-9 (allocator): discriminator(8) + authority(32) + curator(32) + asset_mint(32)
    //   + shares_mint(32) + idle_vault(32) + vault_id(8) + total_shares(8) + idle_buffer_bps(2)
    //   + num_children(1) = byte 187
    let decimals_offset_byte = if discriminator == ALLOCATOR_VAULT_DISCRIMINATOR {
        187usize
    } else {
        136usize
    };
    let child_decimals_offset = vault_data
        .get(decimals_offset_byte)
        .copied()
        .ok_or(VaultError::InvalidChildVault)?;
    require!(child_decimals_offset <= 9, VaultError::InvalidChildVault);

    // 6. UPDATE STATE
    // Initialize ChildAllocation
    let child_allocation = &mut ctx.accounts.child_allocation;
    let allocator_vault_key = ctx.accounts.allocator_vault.key();

    child_allocation.allocator_vault = allocator_vault_key;
    child_allocation.child_vault = ctx.accounts.child_vault.key();
    child_allocation.child_program = ctx.accounts.child_program.key();
    child_allocation.child_shares_account = ctx.accounts.allocator_child_shares_account.key();
    child_allocation.target_weight_bps = 0;
    child_allocation.max_weight_bps = max_weight_bps;
    child_allocation.deposited_assets = 0;
    child_allocation.index = ctx.accounts.allocator_vault.num_children; // pre-increment index
    child_allocation.enabled = true;
    child_allocation.child_decimals_offset = child_decimals_offset;
    child_allocation.bump = ctx.bumps.child_allocation;
    child_allocation._reserved = [0u8; 63];

    // Increment children count in AllocatorVault
    let allocator_vault = &mut ctx.accounts.allocator_vault;
    allocator_vault.num_children = allocator_vault
        .num_children
        .checked_add(1)
        .ok_or(VaultError::MathOverflow)?;

    // 7. EMIT EVENT
    emit!(ChildAdded {
        allocator_vault: allocator_vault.key(),
        child_vault: ctx.accounts.child_vault.key(),
        child_program: ctx.accounts.child_program.key(),
        max_weight_bps,
    });

    Ok(())
}
