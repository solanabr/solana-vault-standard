use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;

use crate::constants::{DEPOSIT_REQUEST_SEED, REDEEM_REQUEST_SEED};
use crate::state::{AsyncVault, DepositRequest, RedeemRequest, RequestStatus};

#[derive(Accounts)]
pub struct VaultView<'info> {
    pub vault: Account<'info, AsyncVault>,
}

pub fn pending_deposit_request(ctx: Context<VaultView>, owner: Pubkey) -> Result<()> {
    let (pda, _) = Pubkey::find_program_address(
        &[
            DEPOSIT_REQUEST_SEED,
            ctx.accounts.vault.key().as_ref(),
            owner.as_ref(),
        ],
        ctx.program_id,
    );
    if let Some(account) = ctx.remaining_accounts.first() {
        if account.key() == pda {
            let data = account.try_borrow_data()?;
            if data.len() >= DepositRequest::LEN {
                let request = DepositRequest::try_deserialize(&mut &data[..])?;
                if request.status == RequestStatus::Pending {
                    set_return_data(&request.assets_locked.to_le_bytes());
                    return Ok(());
                }
            }
        }
    }
    set_return_data(&0u64.to_le_bytes());
    Ok(())
}

pub fn claimable_deposit_request(ctx: Context<VaultView>, owner: Pubkey) -> Result<()> {
    let (pda, _) = Pubkey::find_program_address(
        &[
            DEPOSIT_REQUEST_SEED,
            ctx.accounts.vault.key().as_ref(),
            owner.as_ref(),
        ],
        ctx.program_id,
    );
    if let Some(account) = ctx.remaining_accounts.first() {
        if account.key() == pda {
            let data = account.try_borrow_data()?;
            if data.len() >= DepositRequest::LEN {
                let request = DepositRequest::try_deserialize(&mut &data[..])?;
                if request.status == RequestStatus::Fulfilled {
                    set_return_data(&request.shares_claimable.to_le_bytes());
                    return Ok(());
                }
            }
        }
    }
    set_return_data(&0u64.to_le_bytes());
    Ok(())
}

pub fn pending_redeem_request(ctx: Context<VaultView>, owner: Pubkey) -> Result<()> {
    let (pda, _) = Pubkey::find_program_address(
        &[
            REDEEM_REQUEST_SEED,
            ctx.accounts.vault.key().as_ref(),
            owner.as_ref(),
        ],
        ctx.program_id,
    );
    if let Some(account) = ctx.remaining_accounts.first() {
        if account.key() == pda {
            let data = account.try_borrow_data()?;
            if data.len() >= RedeemRequest::LEN {
                let request = RedeemRequest::try_deserialize(&mut &data[..])?;
                if request.status == RequestStatus::Pending {
                    set_return_data(&request.shares_locked.to_le_bytes());
                    return Ok(());
                }
            }
        }
    }
    set_return_data(&0u64.to_le_bytes());
    Ok(())
}

pub fn claimable_redeem_request(ctx: Context<VaultView>, owner: Pubkey) -> Result<()> {
    let (pda, _) = Pubkey::find_program_address(
        &[
            REDEEM_REQUEST_SEED,
            ctx.accounts.vault.key().as_ref(),
            owner.as_ref(),
        ],
        ctx.program_id,
    );
    if let Some(account) = ctx.remaining_accounts.first() {
        if account.key() == pda {
            let data = account.try_borrow_data()?;
            if data.len() >= RedeemRequest::LEN {
                let request = RedeemRequest::try_deserialize(&mut &data[..])?;
                if request.status == RequestStatus::Fulfilled {
                    set_return_data(&request.assets_claimable.to_le_bytes());
                    return Ok(());
                }
            }
        }
    }
    set_return_data(&0u64.to_le_bytes());
    Ok(())
}
