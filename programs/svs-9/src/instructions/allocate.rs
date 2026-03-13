//! Allocate instruction for SVS-9 allocator vault.

use anchor_lang::prelude::*;

use crate::{
    constants::{
        ALLOCATOR_VAULT_SEED, CHILD_ALLOCATION_SEED, SVS1_VAULT_DISCRIMINATOR,
        TOTAL_ASSETS_OFFSET, TOTAL_SHARES_OFFSET, DECIMALS_OFFSET_OFFSET,
    },
    error::VaultError,
    events::Allocate,
    math::check_idle_buffer,
    state::{AllocatorVault, ChildAllocation},
};

#[derive(Accounts)]
pub struct Allocate<'info> {
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
        bump = child_allocation.bump,
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
    pub amount: u64,
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

/// Read total_assets from child vault (no CPI needed)
fn read_child_total_assets(
    child_vault_info: &AccountInfo,
) -> Result<u64> {
    let data = child_vault_info.try_borrow_data()?;
    
    if data.len() < TOTAL_ASSETS_OFFSET + 8 {
        return Err(error!(VaultError::InvalidAccountData));
    }

    let total_assets_bytes: [u8; 8] = data[TOTAL_ASSETS_OFFSET..TOTAL_ASSETS_OFFSET + 8]
        .try_into()
        .map_err(|_| error!(VaultError::InvalidAccountData))?;

    Ok(u64::from_le_bytes(total_assets_bytes))
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
    ctx: Context<Allocate>,
    child_vault: Pubkey,
    amount: u64,
) -> Result<()> {
    let allocator = &mut ctx.accounts.allocator;
    let child_allocation = &mut ctx.accounts.child_allocation;

    // Validate inputs
    require!(amount > 0, VaultError::ZeroAmount);

    // Validate child vault
    validate_child_for_cpi(
        &child_allocation,
        &ctx.accounts.child_vault.to_account_info(),
        &ctx.accounts.child_program.to_account_info(),
    )?;

    // Read child vault state
    let child_total_assets = read_child_total_assets(&ctx.accounts.child_vault.to_account_info())?;
    let child_total_shares = read_child_total_shares(&ctx.accounts.child_vault.to_account_info())?;
    let child_decimals_offset = read_child_decimals_offset(&ctx.accounts.child_vault.to_account_info())?;

    // Check idle buffer after allocation
    let idle_after = ctx.accounts.idle_vault.amount.checked_sub(amount)
        .ok_or(error!(VaultError::InsufficientLiquidity))?;

    let current_total = allocator.cached_total_assets.checked_add(amount)
        .ok_or(error!(VaultError::MathOverflow))?;

    check_idle_buffer(
        idle_after,
        current_total,
        allocator.idle_buffer_bps,
    )?;

    // Calculate child's current weight to ensure we don't exceed max
    let current_child_value = if child_total_shares > 0 {
        crate::math::mul_div(
            child_allocation.deposited_assets,
            child_total_shares,
            child_total_assets,
            anchor_lang::system_program::program::id::Rounding::Floor,
        )?
    } else {
        0
    };

    let new_child_value = current_child_value.checked_add(amount)
        .ok_or(error!(VaultError::MathOverflow))?;

    let new_weight_bps = crate::math::calculate_actual_weight_bps(
        new_child_value,
        current_total,
    )?;

    require!(
        new_weight_bps <= child_allocation.max_weight_bps,
        VaultError::InvalidWeight
    );

    // Prepare CPI accounts for child vault deposit
    let allocator_seeds = &[
        b"allocator_vault",
        allocator.asset_mint.as_ref(),
        &allocator.vault_id.to_le_bytes(),
        &[allocator.bump],
    ];

    let cpi_accounts = anchor_spl::token::Transfer {
        from: &ctx.accounts.idle_vault,
        to: &ctx.accounts.child_asset_vault,
        authority: allocator,
    };

    // Transfer assets to child vault
    anchor_spl::token::transfer(
        CpiContext::new_with_signer(
            &ctx.accounts.token_program.to_account_info(),
            &cpi_accounts,
            allocator_seeds,
        ),
        amount,
    )?;

    // Call child vault deposit instruction
    let child_program_id = ctx.accounts.child_program.key();
    let child_vault_program_id = ctx.accounts.child_program.key();

    // Create instruction data for child vault deposit
    let instruction_data = anchor_lang::InstructionData {
        discriminator: [211, 8, 232, 43, 2, 152, 117, 119], // deposit discriminator
        accounts: vec![
            AccountMeta::new_readonly(child_vault, false),
            AccountMeta::new(ctx.accounts.child_asset_vault.key(), false),
            AccountMeta::new(ctx.accounts.child_shares_account.key(), false),
            AccountMeta::new(ctx.accounts.child_shares_mint.key(), false),
            AccountMeta::new_readonly(anchor_lang::system_program::program::id::ID, false),
        ],
        data: amount.to_le_bytes().to_vec(),
    };

    // Invoke child vault deposit
    let mut accounts = vec![
        ctx.accounts.child_vault.clone(),
        ctx.accounts.child_asset_vault.clone(),
        ctx.accounts.child_shares_account.clone(),
        ctx.accounts.child_shares_mint.clone(),
        AccountMeta::new_readonly(anchor_lang::system_program::program::id::ID, false),
    ];

    let instruction = Instruction {
        program_id: child_program_id,
        accounts,
        data: instruction_data.try_to_vec()?,
    };

    // Create CPI context
    let cpi_ctx = CpiContext::new_with_signer(
        &ctx.accounts.child_program.to_account_info(),
        &accounts,
        allocator_seeds,
    );

    // Execute CPI
    anchor_lang::solana_program::invoke_signed(
        &instruction,
        &cpi_ctx.to_account_metas(),
        allocator_seeds,
    )?;

    // Update child allocation state
    child_allocation.deposited_assets = child_allocation.deposited_assets.checked_add(amount)
        .ok_or(error!(VaultError::MathOverflow))?;

    // Update allocator cache
    allocator.cached_total_assets = current_total;
    allocator.cache_timestamp = Clock::get()?.unix_timestamp;

    emit_cpi!(Allocate {
        allocator: allocator.key(),
        child_vault,
        amount,
        child_shares_received: 0, // Would need to read from child_shares_account after CPI
        idle_after: ctx.accounts.idle_vault.amount,
    });

    Ok(())
}
