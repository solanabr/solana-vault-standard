use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::{
    self, spl_token_2022::solana_program::program_pack::Pack, Burn, Token2022,
};
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    constants::*,
    error::VaultError,
    events::RedeemFulfilled,
    math::{convert_to_assets, Rounding},
    state::{AsyncVault, ClaimableEscrow, OraclePrice, RedeemRequest, RequestStatus},
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct FulfillRedeem<'info> {
    #[account(mut)]
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
        seeds = [REDEEM_REQUEST_SEED, vault.key().as_ref(), redeem_request.owner.as_ref()],
        bump = redeem_request.bump,
    )]
    pub redeem_request: Account<'info, RedeemRequest>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = share_escrow.key() == vault.share_escrow,
    )]
    pub share_escrow: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = asset_vault.key() == vault.asset_vault,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Per-user claimable token account, created via CPI
    #[account(
        mut,
        seeds = [CLAIMABLE_TOKENS_SEED, vault.key().as_ref(), redeem_request.owner.as_ref()],
        bump
    )]
    pub claimable_tokens: UncheckedAccount<'info>,

    #[account(
        init,
        payer = operator,
        space = ClaimableEscrow::LEN,
        seeds = [CLAIMABLE_SEED, vault.key().as_ref(), redeem_request.owner.as_ref()],
        bump
    )]
    pub claimable_escrow: Account<'info, ClaimableEscrow>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
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

pub fn handler(ctx: Context<FulfillRedeem>) -> Result<()> {
    let request = &ctx.accounts.redeem_request;

    require!(
        request.status == RequestStatus::Pending,
        VaultError::RequestNotPending
    );

    let vault = &ctx.accounts.vault;
    let vault_key = vault.key();
    let shares_locked = request.shares_locked;

    // Compute gross assets: Mode A (oracle) or Mode B (vault-priced)
    let gross_assets = if let Some((price, updated_at)) =
        find_oracle_price(ctx.remaining_accounts, &crate::ID, &vault_key)?
    {
        let clock = Clock::get()?;
        svs_oracle::validate_oracle(price, updated_at, clock.unix_timestamp, vault.max_staleness)
            .map_err(|e| match e {
            svs_oracle::OracleError::StalePrice => VaultError::StaleOraclePrice,
            _ => VaultError::InvalidOraclePrice,
        })?;
        svs_oracle::shares_to_assets(shares_locked, price).map_err(|_| VaultError::MathOverflow)?
    } else {
        convert_to_assets(
            shares_locked,
            vault.total_assets,
            vault.total_shares,
            vault.decimals_offset,
            Rounding::Floor,
        )?
    };

    // Apply module hooks if enabled
    #[cfg(feature = "modules")]
    let assets = {
        let remaining = ctx.remaining_accounts;
        let result = module_hooks::apply_exit_fee(remaining, &crate::ID, &vault_key, gross_assets)?;
        result.net_assets
    };

    #[cfg(not(feature = "modules"))]
    let assets = gross_assets;

    require!(
        ctx.accounts.asset_vault.amount >= assets,
        VaultError::InsufficientAssets
    );

    let asset_mint_key = vault.asset_mint;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let vault_bump = vault.bump;
    let vault_signer_seeds: &[&[&[u8]]] = &[&[
        ASYNC_VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[vault_bump],
    ]];

    // Burn shares from escrow
    token_2022::burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            Burn {
                mint: ctx.accounts.shares_mint.to_account_info(),
                from: ctx.accounts.share_escrow.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            vault_signer_seeds,
        ),
        shares_locked,
    )?;

    // Create per-user claimable_tokens account if needed
    let claimable_tokens_bump = ctx.bumps.claimable_tokens;
    let owner_key = request.owner;
    let claimable_tokens_seeds: &[&[u8]] = &[
        CLAIMABLE_TOKENS_SEED,
        vault_key.as_ref(),
        owner_key.as_ref(),
        &[claimable_tokens_bump],
    ];

    let token_account_size = spl_token_2022::state::Account::LEN;
    let rent = &ctx.accounts.rent;
    let lamports = rent.minimum_balance(token_account_size);

    invoke_signed(
        &anchor_lang::solana_program::system_instruction::create_account(
            &ctx.accounts.operator.key(),
            &ctx.accounts.claimable_tokens.key(),
            lamports,
            token_account_size as u64,
            &ctx.accounts.asset_token_program.key(),
        ),
        &[
            ctx.accounts.operator.to_account_info(),
            ctx.accounts.claimable_tokens.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[claimable_tokens_seeds],
    )?;

    invoke_signed(
        &spl_token_2022::instruction::initialize_account3(
            &ctx.accounts.asset_token_program.key(),
            &ctx.accounts.claimable_tokens.key(),
            &asset_mint_key,
            &vault_key,
        )?,
        &[
            ctx.accounts.claimable_tokens.to_account_info(),
            ctx.accounts.asset_mint.to_account_info(),
        ],
        &[claimable_tokens_seeds],
    )?;

    // Transfer assets from asset_vault to claimable_tokens
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.asset_vault.to_account_info(),
                to: ctx.accounts.claimable_tokens.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            vault_signer_seeds,
        ),
        assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    // Update vault totals (Bug #1: decrement here, not at claim)
    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault
        .total_assets
        .checked_sub(assets)
        .ok_or(VaultError::MathOverflow)?;
    vault.total_shares = vault
        .total_shares
        .checked_sub(shares_locked)
        .ok_or(VaultError::MathOverflow)?;

    // Set claimable escrow state
    let claimable_escrow = &mut ctx.accounts.claimable_escrow;
    claimable_escrow.vault = vault.key();
    claimable_escrow.owner = owner_key;
    claimable_escrow.amount = assets;
    claimable_escrow.bump = ctx.bumps.claimable_escrow;

    // Update request
    let clock = Clock::get()?;
    let request = &mut ctx.accounts.redeem_request;
    request.assets_claimable = assets;
    request.status = RequestStatus::Fulfilled;
    request.fulfilled_at = clock.unix_timestamp;

    emit!(RedeemFulfilled {
        vault: vault.key(),
        owner: owner_key,
        shares: shares_locked,
        assets,
    });

    Ok(())
}
