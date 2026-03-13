//! Rebalance instruction for SVS-9 allocator vault.

use anchor_lang::prelude::*;

use crate::{
    constants::{
        ALLOCATOR_VAULT_SEED, CHILD_ALLOCATION_SEED, SVS1_VAULT_DISCRIMINATOR,
        TOTAL_ASSETS_OFFSET, TOTAL_SHARES_OFFSET, DECIMALS_OFFSET_OFFSET,
    },
    error::VaultError,
    events::Rebalance,
    state::{AllocatorVault, ChildAllocation},
};

#[derive(Accounts)]
pub struct Rebalance<'info> {
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
        seeds = [CHILD_ALLOCATION_SEED, allocator.key().as_ref(), from_child.key().as_ref()],
        bump,
        constraint = from_child_allocation.allocator_vault == allocator.key(),
        constraint = from_child_allocation.child_vault == from_child.key(),
        constraint = from_child_allocation.enabled @ ChildAllocationDisabled
    )]
    pub from_child_allocation: Box<Account<'info, ChildAllocation>>,

    #[account(
        mut,
        seeds = [CHILD_ALLOCATION_SEED, allocator.key().as_ref(), to_child.key().as_ref()],
        bump,
        constraint = to_child_allocation.allocator_vault == allocator.key(),
        constraint = to_child_allocation.child_vault == to_child.key(),
        constraint = to_child_allocation.enabled @ ChildAllocationDisabled
    )]
    pub to_child_allocation: Box<Account<'info, ChildAllocation>>,

    /// CHECK: From child vault account
    pub from_child_vault: UncheckedAccount<'info>,

    /// CHECK: From child program
    pub from_child_program: UncheckedAccount<'info>,

    /// CHECK: To child vault account
    pub to_child_vault: UncheckedAccount<'info>,

    /// CHECK: To child program
    pub to_child_program: UncheckedAccount<'info>,

    /// CHECK: Allocator's share token account in from child
    pub from_child_shares_account: UncheckedAccount<'info>,

    /// CHECK: Allocator's share token account in to child
    pub to_child_shares_account: UncheckedAccount<'info>,

    /// CHECK: From child's asset vault
    pub from_child_asset_vault: UncheckedAccount<'info>,

    /// CHECK: To child's asset vault
    pub to_child_asset_vault: UncheckedAccount<'info>,

    /// CHECK: From child's shares mint
    pub from_child_shares_mint: UncheckedAccount<'info>,

    /// CHECK: To child's shares mint
    pub to_child_shares_mint: UncheckedAccount<'info>,

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
    pub from_child: Pubkey,
    pub to_child: Pubkey,
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

pub fn handler(
    ctx: Context<Rebalance>,
    from_child: Pubkey,
    to_child: Pubkey,
    amount: u64,
) -> Result<()> {
    let allocator = &mut ctx.accounts.allocator;
    let from_child_allocation = &mut ctx.accounts.from_child_allocation;
    let to_child_allocation = &mut ctx.accounts.to_child_allocation;

    // Validate inputs
    require!(amount > 0, VaultError::ZeroAmount);

    // Validate both child vaults
    validate_child_for_cpi(
        &from_child_allocation,
        &ctx.accounts.from_child_vault.to_account_info(),
        &ctx.accounts.from_child_program.to_account_info(),
    )?;

    validate_child_for_cpi(
        &to_child_allocation,
        &ctx.accounts.to_child_vault.to_account_info(),
        &ctx.accounts.to_child_program.to_account_info(),
    )?;

    // Prepare allocator seeds for CPI
    let allocator_seeds = &[
        b"allocator_vault",
        allocator.asset_mint.as_ref(),
        &allocator.vault_id.to_le_bytes(),
        &[allocator.bump],
    ];

    // Step 1: Deallocate from source child
    let from_child_total_shares = read_child_total_shares(&ctx.accounts.from_child_vault.to_account_info())?;
    let shares_to_redeem = if from_child_total_shares > 0 {
        // Calculate shares to redeem based on amount
        crate::math::mul_div(
            amount,
            from_child_total_shares,
            from_child_allocation.deposited_assets,
            anchor_lang::system_program::program::id::Rounding::Floor,
        )?
    } else {
        0
    };

    // Create redeem instruction for from child
    let redeem_instruction_data = anchor_lang::InstructionData {
        discriminator: [44, 29, 174, 228, 164, 118, 97, 189], // redeem discriminator
        accounts: vec![
            AccountMeta::new_readonly(from_child_allocation.child_vault, false),
            AccountMeta::new(from_child_allocation.child_shares_account, false),
            AccountMeta::new(ctx.accounts.idle_vault.key(), false),
            AccountMeta::new_readonly(anchor_lang::system_program::program::id::ID, false),
        ],
        data: (shares_to_redeem, 0u64) // shares, min_assets_out
            .try_to_vec()
            .map_err(|_| error!(VaultError::InvalidAccountData))?,
    };

    let redeem_accounts = vec![
        ctx.accounts.from_child_vault.clone(),
        ctx.accounts.from_child_shares_account.clone(),
        ctx.accounts.idle_vault.to_account_info(),
        AccountMeta::new_readonly(anchor_lang::system_program::program::id::ID, false),
    ];

    let redeem_instruction = Instruction {
        program_id: from_child_allocation.child_program,
        accounts: redeem_accounts,
        data: redeem_instruction_data,
    };

    // Step 2: Allocate to target child
    let allocate_instruction_data = anchor_lang::InstructionData {
        discriminator: [211, 8, 232, 43, 2, 152, 117, 119], // deposit discriminator
        accounts: vec![
            AccountMeta::new_readonly(to_child_allocation.child_vault, false),
            AccountMeta::new(to_child_allocation.child_asset_vault, false),
            AccountMeta::new(to_child_allocation.child_shares_account, false),
            AccountMeta::new(to_child_allocation.child_shares_mint, false),
            AccountMeta::new_readonly(anchor_lang::system_program::program::id::ID, false),
        ],
        data: amount.to_le_bytes().to_vec(),
    };

    let allocate_accounts = vec![
        ctx.accounts.to_child_vault.clone(),
        ctx.accounts.to_child_asset_vault.clone(),
        ctx.accounts.to_child_shares_account.clone(),
        ctx.accounts.to_child_shares_mint.clone(),
        AccountMeta::new_readonly(anchor_lang::system_program::program::id::ID, false),
    ];

    let allocate_instruction = Instruction {
        program_id: to_child_allocation.child_program,
        accounts: allocate_accounts,
        data: allocate_instruction_data,
    };

    // Execute both CPIs
    let cpi_ctx = CpiContext::new_with_signer(
        &ctx.accounts.from_child_program.to_account_info(),
        &redeem_accounts,
        allocator_seeds,
    );

    anchor_lang::solana_program::invoke_signed(
        &redeem_instruction,
        &cpi_ctx.to_account_metas(),
        allocator_seeds,
    )?;

    let cpi_ctx = CpiContext::new_with_signer(
        &ctx.accounts.to_child_program.to_account_info(),
        &allocate_accounts,
        allocator_seeds,
    );

    anchor_lang::solana_program::invoke_signed(
        &allocate_instruction,
        &cpi_ctx.to_account_metas(),
        allocator_seeds,
    )?;

    // Update allocation states
    from_child_allocation.deposited_assets = from_child_allocation.deposited_assets.checked_sub(amount)
        .ok_or(error!(VaultError::InsufficientAssets))?;

    to_child_allocation.deposited_assets = to_child_allocation.deposited_assets.checked_add(amount)
        .ok_or(error!(VaultError::MathOverflow))?;

    // Update allocator cache
    allocator.cache_timestamp = Clock::get()?.unix_timestamp;

    emit_cpi!(Rebalance {
        allocator: allocator.key(),
        from_child,
        to_child,
        amount,
        from_shares: shares_to_redeem,
        to_shares: 0, // Would need to read from child_shares_account after CPI
    });

    Ok(())
}
