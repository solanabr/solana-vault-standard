use anchor_lang::prelude::*;

use crate::{
    constants::{DEPOSIT_REQUEST_SEED, ORACLE_PRICE_SEED},
    error::VaultError,
    events::DepositFulfilled,
    math::{convert_to_shares, Rounding},
    state::{AsyncVault, DepositRequest, OraclePrice, RequestStatus},
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct FulfillDeposit<'info> {
    pub operator: Signer<'info>,

    #[account(
        mut,
        constraint = vault.operator == operator.key() @ VaultError::Unauthorized,
        constraint = vault.operator != Pubkey::default() @ VaultError::OperatorNotSet,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        has_one = vault,
        seeds = [DEPOSIT_REQUEST_SEED, vault.key().as_ref(), deposit_request.owner.as_ref()],
        bump = deposit_request.bump,
    )]
    pub deposit_request: Account<'info, DepositRequest>,
}

fn find_oracle_price<'info>(
    remaining_accounts: &[AccountInfo<'info>],
    program_id: &Pubkey,
    vault_key: &Pubkey,
) -> Result<Option<(u64, i64)>> {
    let (expected_pda, _) =
        Pubkey::find_program_address(&[ORACLE_PRICE_SEED, vault_key.as_ref()], program_id);

    for account in remaining_accounts {
        if account.key() == expected_pda {
            let data = account.try_borrow_data()?;
            if data.len() >= OraclePrice::LEN {
                let oracle: OraclePrice = AnchorDeserialize::deserialize(&mut &data[8..])?;
                require!(oracle.vault == *vault_key, VaultError::OracleVaultMismatch);
                return Ok(Some((oracle.price, oracle.updated_at)));
            }
        }
    }

    Ok(None)
}

pub fn handler(ctx: Context<FulfillDeposit>) -> Result<()> {
    let request = &ctx.accounts.deposit_request;

    require!(
        request.status == RequestStatus::Pending,
        VaultError::RequestNotPending
    );

    let vault = &ctx.accounts.vault;
    let vault_key = vault.key();

    // Compute gross shares: Mode A (oracle) or Mode B (vault-priced)
    let gross_shares = if let Some((price, updated_at)) =
        find_oracle_price(ctx.remaining_accounts, &crate::ID, &vault_key)?
    {
        let clock = Clock::get()?;
        svs_oracle::validate_oracle(price, updated_at, clock.unix_timestamp, vault.max_staleness)
            .map_err(|e| match e {
            svs_oracle::OracleError::StalePrice => VaultError::StaleOraclePrice,
            _ => VaultError::InvalidOraclePrice,
        })?;
        svs_oracle::assets_to_shares(request.assets_locked, price)
            .map_err(|_| VaultError::MathOverflow)?
    } else {
        convert_to_shares(
            request.assets_locked,
            vault.total_assets,
            vault.total_shares,
            vault.decimals_offset,
            Rounding::Floor,
        )?
    };

    // Apply module hooks if enabled
    #[cfg(feature = "modules")]
    let shares = {
        let remaining = ctx.remaining_accounts;
        let owner_key = request.owner;

        module_hooks::check_deposit_access(remaining, &crate::ID, &vault_key, &owner_key, &[])?;
        module_hooks::check_deposit_caps(
            remaining,
            &crate::ID,
            &vault_key,
            &owner_key,
            vault.total_assets,
            request.assets_locked,
        )?;

        let result =
            module_hooks::apply_entry_fee(remaining, &crate::ID, &vault_key, gross_shares)?;
        result.net_shares
    };

    #[cfg(not(feature = "modules"))]
    let shares = gross_shares;

    // Bug #1: Increment totals HERE only (claim_deposit must NOT touch these)
    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault
        .total_assets
        .checked_add(request.assets_locked)
        .ok_or(VaultError::MathOverflow)?;
    vault.total_shares = vault
        .total_shares
        .checked_add(shares)
        .ok_or(VaultError::MathOverflow)?;

    let clock = Clock::get()?;
    let request = &mut ctx.accounts.deposit_request;
    request.shares_claimable = shares;
    request.status = RequestStatus::Fulfilled;
    request.fulfilled_at = clock.unix_timestamp;

    emit!(DepositFulfilled {
        vault: vault.key(),
        owner: request.owner,
        assets: request.assets_locked,
        shares,
    });

    Ok(())
}
