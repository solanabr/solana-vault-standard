//! Deallocate instruction for SVS-9 allocator vault.

use anchor_lang::prelude::*;

use crate::{
    constants::{
        ALLOCATOR_VAULT_SEED, CHILD_ALLOCATION_SEED, SVS1_VAULT_DISCRIMINATOR,
        TOTAL_ASSETS_OFFSET, TOTAL_SHARES_OFFSET, DECIMALS_OFFSET_OFFSET,
    },
    error::VaultError,
    events::Deallocate,
    state::{AllocatorVault, ChildAllocation},
    math::convert_to_shares,
};

#[derive(Accounts)]
pub struct Deallocate<'info> {
    #[account(mut)]
    pub curator: Signer<'info>,

    #[account(
        mut,
        seeds = [ALLOCATOR_VAULT_SEED, asset_mint.key().as_ref(), vault_id.to_le_bytes().as_ref()],
        bump = allocator.bump,
        constraint = !allocator.paused @ VaultPaused,
        constraint = curator.key() == allocator.curator @ InvalidCurator
    )]
    pub allocator: Box<Account<'info, AllocatorVault>>,

    #[account(constraint = asset_mint.supply > 0)]
    pub asset_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [CHILD_ALLOCATION_SEED, allocator.key().as_ref(), child_vault.key().as_ref()],
        bump,
        constraint = child_allocation.allocator_vault == allocator.key(),
        constraint = child_allocation.child_vault == child_vault.key(),
        constraint = child_allocation.enabled @ ChildAllocationDisabled
    )]
    pub child_allocation: Box<Account<'info, ChildAllocation>>,

    /// CHECK: Child vault account
    pub child_vault: UncheckedAccount<'info>,

    /// CHECK: Child vault program
    pub child_program: UncheckedAccount<'info>,

    /// CHECK: Allocator's share token account in child vault
    pub child_shares_account: UncheckedAccount<'info>,

    /// CHECK: Child vault's asset vault
    pub child_asset_vault: UncheckedAccount<'info>,

    /// CHECK: Child vault's shares mint
    pub child_shares_mint: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"idle_vault", allocator.key().as_ref()],
        bump,
        token::authority = allocator,
        token::mint = asset_mint,
    )]
    pub idle_vault: Box<Account<'info, TokenAccount>>,

    #[account(address = "anchor::spl::token::ID")]
    pub token_program: Program<'info, Token>,
    #[account(address = "anchor::spl::associated_token::ID")]
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
    pub vault_id: u64,
    pub child_vault: Pubkey,
    pub shares: u64,
}

/// Validate child vault before CPI
fn validate_child_for_cpi(
    child_allocation: &ChildAllocation,
    child_vault_info: &AccountInfo,
    child_program_info: &AccountInfo,
) -> Result<()> {
    // Verify child program matches registered program
    require!(
        child_program_info.key() == &child_allocation.child_program,
        VaultError::InvalidChildProgram
    );

    // Verify child vault account is owned by registered program
    require!(
        child_vault_info.owner == &child_allocation.child_program,
        VaultError::InvalidChildProgram
    );

    // Verify child vault PDA matches registered address
    require!(
        child_vault_info.key() == &child_allocation.child_vault,
        VaultError::InvalidChildVault
    );

    // Validate discriminator matches expected vault type
    let data = child_vault_info.try_borrow_data()?;
    if data.len() < 8 {
        return Err(error!(VaultError::InvalidAccountData));
    }
    
    let discriminator = &data[..8];
    require!(
        discriminator == &SVS1_VAULT_DISCRIMINATOR,
        VaultError::UnsupportedChildVariant
    );

    Ok(())
}

/// Read total_shares from child vault
fn read_child_total_shares(
    child_vault_info: &AccountInfo,
) -> Result<u64> {
    let data = child_vault_info.try_borrow_data()?;
    
    if data.len() < TOTAL_SHARES_OFFSET + 8 {
        return Err(error!(VaultError::InvalidAccountData));
    }

    let total_shares_bytes: [u8; 8] = data[TOTAL_SHARES_OFFSET..TOTAL_SHARES_OFFSET + 8]
        .try_into()
        .map_err(|_| error!(VaultError::InvalidAccountData))?;

    Ok(u64::from_le_bytes(total_shares_bytes))
}

/// Read decimals_offset from child vault
fn read_child_decimals_offset(
    child_vault_info: &AccountInfo,
) -> Result<u8> {
    let data = child_vault_info.try_borrow_data()?;
    
    if data.len() < DECIMALS_OFFSET_OFFSET + 1 {
        return Err(error!(VaultError::InvalidAccountData));
    }

    Ok(data[DECIMALS_OFFSET_OFFSET])
}

pub fn handler(
    ctx: Context<Deallocate>,
    child_vault: Pubkey,
    shares: u64,
) -> Result<()> {
    let allocator = &mut ctx.accounts.allocator;
    let child_allocation = &mut ctx.accounts.child_allocation;

    // Validate inputs
    require!(shares > 0, VaultError::ZeroAmount);

    // Validate child vault
    validate_child_for_cpi(
        &child_allocation,
        &ctx.accounts.child_vault.to_account_info(),
        &ctx.accounts.child_program.to_account_info(),
    )?;

    // Read child vault state
    let child_total_shares = read_child_total_shares(&ctx.accounts.child_vault.to_account_info())?;
    let child_decimals_offset = read_child_decimals_offset(&ctx.accounts.child_vault.to_account_info())?;

    // Calculate expected assets to receive
    let expected_assets = if child_total_shares > 0 {
        crate::math::mul_div(
            shares,
            child_total_shares,
            child_allocation.deposited_assets,
            anchor_lang::system_program::program::id::Rounding::Floor,
        )?
    } else {
        0
    };

    // Prepare CPI accounts for child vault redeem
    let allocator_seeds = &[
        b"allocator_vault",
        allocator.asset_mint.as_ref(),
        &allocator.vault_id.to_le_bytes(),
        &[allocator.bump],
    ];

    // Create instruction data for child vault redeem
    let instruction_data = anchor_lang::InstructionData {
        discriminator: [44, 29, 174, 228, 164, 118, 97, 189], // redeem discriminator
        accounts: vec![
            AccountMeta::new_readonly(child_allocation.child_vault, false),
            AccountMeta::new(child_allocation.child_shares_account, false),
            AccountMeta::new(ctx.accounts.idle_vault.key(), false),
            AccountMeta::new_readonly(anchor_lang::system_program::program::id::ID, false),
        ],
        data: (shares, 0u64) // shares, min_assets_out
            .try_to_vec()
            .map_err(|_| error!(VaultError::InvalidAccountData))?,
    };

    let accounts = vec![
        ctx.accounts.child_vault.clone(),
        ctx.accounts.child_shares_account.clone(),
        ctx.accounts.idle_vault.to_account_info(),
        AccountMeta::new_readonly(anchor_lang::system_program::program::id::ID, false),
    ];

    let instruction = Instruction {
        program_id: child_allocation.child_program,
        accounts,
        data: instruction_data,
    };

    // Execute CPI
    let cpi_ctx = CpiContext::new_with_signer(
        &ctx.accounts.child_program.to_account_info(),
        &accounts,
        allocator_seeds,
    );

    anchor_lang::solana_program::invoke_signed(
        &instruction,
        &cpi_ctx.to_account_metas(),
        allocator_seeds,
    )?;

    // Update child allocation state
    child_allocation.deposited_assets = child_allocation.deposited_assets.checked_sub(expected_assets)
        .ok_or(error!(VaultError::InsufficientAssets))?;

    // Update allocator cache
    allocator.cache_timestamp = Clock::get()?.unix_timestamp;

    emit_cpi!(Deallocate {
        allocator: allocator.key(),
        child_vault,
        shares,
        assets_received: expected_assets,
        idle_after: ctx.accounts.idle_vault.amount,
    });

    Ok(())
}
