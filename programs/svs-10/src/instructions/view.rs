//! View instructions: read-only queries for async vault request state.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;

use crate::state::{AsyncVault, DepositRequest, RedeemRequest, RequestStatus};

#[derive(Accounts)]
pub struct VaultView<'info> {
    pub vault: Account<'info, AsyncVault>,
}

pub fn pending_deposit_request(ctx: Context<VaultView>) -> Result<()> {
    if let Some(account) = ctx.remaining_accounts.first() {
        let data = account.try_borrow_data()?;
        if data.len() >= DepositRequest::LEN {
            let request = DepositRequest::try_deserialize(&mut &data[..])?;
            if request.vault == ctx.accounts.vault.key() && request.status == RequestStatus::Pending
            {
                set_return_data(&request.assets_locked.to_le_bytes());
                return Ok(());
            }
        }
    }
    set_return_data(&0u64.to_le_bytes());
    Ok(())
}

pub fn claimable_deposit_request(ctx: Context<VaultView>) -> Result<()> {
    if let Some(account) = ctx.remaining_accounts.first() {
        let data = account.try_borrow_data()?;
        if data.len() >= DepositRequest::LEN {
            let request = DepositRequest::try_deserialize(&mut &data[..])?;
            if request.vault == ctx.accounts.vault.key()
                && request.status == RequestStatus::Fulfilled
            {
                set_return_data(&request.shares_claimable.to_le_bytes());
                return Ok(());
            }
        }
    }
    set_return_data(&0u64.to_le_bytes());
    Ok(())
}

pub fn pending_redeem_request(ctx: Context<VaultView>) -> Result<()> {
    if let Some(account) = ctx.remaining_accounts.first() {
        let data = account.try_borrow_data()?;
        if data.len() >= RedeemRequest::LEN {
            let request = RedeemRequest::try_deserialize(&mut &data[..])?;
            if request.vault == ctx.accounts.vault.key() && request.status == RequestStatus::Pending
            {
                set_return_data(&request.shares_locked.to_le_bytes());
                return Ok(());
            }
        }
    }
    set_return_data(&0u64.to_le_bytes());
    Ok(())
}

pub fn claimable_redeem_request(ctx: Context<VaultView>) -> Result<()> {
    if let Some(account) = ctx.remaining_accounts.first() {
        let data = account.try_borrow_data()?;
        if data.len() >= RedeemRequest::LEN {
            let request = RedeemRequest::try_deserialize(&mut &data[..])?;
            if request.vault == ctx.accounts.vault.key()
                && request.status == RequestStatus::Fulfilled
            {
                set_return_data(&request.assets_claimable.to_le_bytes());
                return Ok(());
            }
        }
    }
    set_return_data(&0u64.to_le_bytes());
    Ok(())
}
