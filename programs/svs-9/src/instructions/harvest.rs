//! Harvest instruction for SVS-9 allocator vault.

use anchor_lang::prelude::*;

use crate::{
    constants::{
        ALLOCATOR_VAULT_SEED, CHILD_ALLOCATION_SEED, SVS1_VAULT_DISCRIMINATOR,
        TOTAL_ASSETS_OFFSET, TOTAL_SHARES_OFFSET, DECIMALS_OFFSET_OFFSET, HARVEST_BATCH_SIZE,
    },
    error::VaultError,
    events::{Harvest, ChildHarvested},
    math::{convert_to_shares, mul_div},
    state::{AllocatorVault, ChildAllocation},
};

#[derive(Accounts)]
pub struct Harvest<'info> {
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
        seeds = [b"idle_vault", allocator.key().as_ref()],
        bump,
        token::authority = allocator,
        token::mint = asset_mint,
    )]
    pub idle_vault: Box<Account<'info, TokenAccount>>,

    /// Remaining accounts: groups of [ChildAllocation, child_vault, child_shares_account, child_program]
    pub remaining_accounts: Vec<AccountInfo<'info>>,
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

/// Read total_assets from child vault
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

/// Get token account balance
fn get_token_account_balance(
    account_info: &AccountInfo,
) -> Result<u64> {
    let data = account_info.try_borrow_data()?;
    if data.len() < 64 {
        return Err(error!(VaultError::InvalidAccountData));
    }

    // Token account structure: discriminator (8) + mint (32) + owner (32) + amount (8)
    let amount_bytes: [u8; 8] = data[72..80]
        .try_into()
        .map_err(|_| error!(VaultError::InvalidAccountData))?;

    Ok(u64::from_le_bytes(amount_bytes))
}

pub fn handler(ctx: Context<Harvest>) -> Result<()> {
    let allocator = &mut ctx.accounts.allocator;
    let mut total_harvested = 0u64;
    let mut children_harvested = 0u32;

    // Process children in batches
    let chunks = ctx.remaining_accounts.chunks_exact(4);
    
    for (batch_idx, chunk) in chunks.enumerate() {
        for child_idx in 0..chunk.len() {
            // Each child needs 4 accounts: allocation, vault, shares, program
            let accounts_per_child = 4;
            if child_idx + 1 > chunk.len() / accounts_per_child {
                continue;
            }

            let child_accounts = &chunk[child_idx * accounts_per_child..(child_idx + 1) * accounts_per_child];
            if child_accounts.len() != accounts_per_child {
                continue;
            }

            let child_allocation_info = &child_accounts[0];
            let child_vault_info = &child_accounts[1];
            let child_shares_info = &child_accounts[2];
            let child_program_info = &child_accounts[3];

            // Deserialize child allocation
            let child_allocation: Account<ChildAllocation> = Account::try_from(child_allocation_info)?;

            if !child_allocation.enabled {
                continue;
            }

            // Validate child program
            validate_child_for_cpi(
                &child_allocation,
                child_vault_info,
                child_program_info,
            )?;

            // Read current position value
            let child_total_assets = read_child_total_assets(child_vault_info)?;
            let our_shares = get_token_account_balance(child_shares_info)?;
            let child_total_shares = read_child_total_shares(child_vault_info)?;
            let child_decimals_offset = read_child_decimals_offset(child_vault_info)?;

            let our_value = mul_div(
                our_shares,
                child_total_shares,
                child_total_assets,
                anchor_lang::system_program::program::id::Rounding::Floor,
            )?;

            // Calculate yield (current value - cost basis)
            let cost_basis = child_allocation.deposited_assets;
            let yield_amount = our_value.saturating_sub(cost_basis);

            if yield_amount == 0 {
                continue; // No yield to harvest
            }

            // Calculate shares to redeem for yield portion
            let shares_to_redeem = convert_to_shares(
                yield_amount,
                child_total_shares,
                child_total_assets,
                child_decimals_offset,
            )?;

            if shares_to_redeem == 0 {
                continue; // Rounding resulted in zero shares
            }

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
                data: (shares_to_redeem, 0u64) // shares, min_assets_out
                    .try_to_vec()
                    .map_err(|_| error!(VaultError::InvalidAccountData))?,
            };

            // Create CPI accounts
            let accounts = vec![
                child_vault_info.clone(),
                child_shares_info.clone(),
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
                child_program_info,
                &accounts,
                allocator_seeds,
            );

            anchor_lang::solana_program::invoke_signed(
                &instruction,
                &cpi_ctx.to_account_metas(),
                allocator_seeds,
            )?;

            // Update state
            total_harvested = total_harvested.checked_add(yield_amount)
                .ok_or(error!(VaultError::MathOverflow))?;
            children_harvested += 1;

            emit_cpi!(ChildHarvested {
                allocator: allocator.key(),
                child_vault: child_allocation.child_vault,
                shares_redeemed: shares_to_redeem,
                assets_received: yield_amount,
                yield_amount,
            });
        }
    }

    // Update allocator cache timestamp
    allocator.cache_timestamp = Clock::get()?.unix_timestamp;

    emit_cpi!(Harvest {
        allocator: allocator.key(),
        total_harvested,
        children_harvested,
    });

    Ok(())
}
