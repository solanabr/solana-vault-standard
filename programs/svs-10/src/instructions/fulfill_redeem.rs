//! fulfill_redeem: Burn shares from escrow, transfer assets to per-user claimable account.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::{
    token_2022::{self, Burn, Token2022},
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};
// SPL Token account layout size (Pack::get_packed_len() for spl_token::state::Account)
const SPL_TOKEN_ACCOUNT_SIZE: usize = 165;

use crate::{
    constants::{
        ASYNC_VAULT_SEED, CLAIMABLE_SEED, CLAIMABLE_TOKENS_SEED, REDEEM_REQUEST_SEED,
        SHARE_ESCROW_SEED,
    },
    error::VaultError,
    events::RedeemFulfilled,
    math::{convert_to_assets, Rounding},
    state::{AsyncVault, ClaimableEscrow, RedeemRequest, RequestStatus},
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct FulfillRedeem<'info> {
    /// Must be vault.operator
    #[account(mut)]
    pub operator: Signer<'info>,

    #[account(
        mut,
        seeds = [ASYNC_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = !vault.paused @ VaultError::VaultPaused,
        constraint = vault.operator == operator.key() @ VaultError::InvalidOperator,
    )]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        seeds = [REDEEM_REQUEST_SEED, vault.key().as_ref(), redeem_request.owner.as_ref()],
        bump = redeem_request.bump,
        has_one = vault @ VaultError::Unauthorized,
    )]
    pub redeem_request: Account<'info, RedeemRequest>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint @ VaultError::Unauthorized,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = asset_vault.key() == vault.asset_vault @ VaultError::Unauthorized,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint @ VaultError::Unauthorized,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    /// Share escrow — shares are burned from here
    #[account(
        mut,
        seeds = [SHARE_ESCROW_SEED, vault.key().as_ref()],
        bump,
        constraint = share_escrow.key() == vault.share_escrow @ VaultError::Unauthorized,
    )]
    pub share_escrow: InterfaceAccount<'info, TokenAccount>,

    /// Per-user claimable token account — created here, holds assets until claim_redeem.
    /// Seeds: ["claimable_tokens", vault_pda, owner]
    /// CHECK: initialized via CPI below using system_instruction + initialize_account3
    #[account(
        mut,
        seeds = [CLAIMABLE_TOKENS_SEED, vault.key().as_ref(), redeem_request.owner.as_ref()],
        bump,
    )]
    pub claimable_tokens: UncheckedAccount<'info>,

    /// ClaimableEscrow PDA — tracks amount claimable per user
    /// Seeds: ["claimable", vault_pda, owner]
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

pub fn handler(ctx: Context<FulfillRedeem>) -> Result<()> {
    // 1. VALIDATION: request must be Pending
    require!(
        ctx.accounts.redeem_request.status == RequestStatus::Pending,
        VaultError::RequestNotPending
    );

    let vault = &ctx.accounts.vault;
    let shares_locked = ctx.accounts.redeem_request.shares_locked;
    let owner = ctx.accounts.redeem_request.owner;
    let vault_key = vault.key();

    // 2. COMPUTE ASSETS using vault-priced mode
    // Floor rounding — vault-favoring for redemptions.
    let assets_claimable = convert_to_assets(
        shares_locked,
        vault.total_assets,
        vault.total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    // 3. MODULE HOOK: apply exit fee at fulfillment
    #[cfg(feature = "modules")]
    let assets_claimable = {
        let remaining = ctx.remaining_accounts;
        let result = module_hooks::apply_exit_fee(remaining, &crate::ID, &vault_key, assets_claimable)?;
        result.net_assets
    };

    require!(assets_claimable > 0, VaultError::ZeroAmount);

    // 4. BUILD VAULT PDA SIGNER SEEDS
    let asset_mint_key = vault.asset_mint;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        ASYNC_VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[bump],
    ]];

    // 5. BURN SHARES from share_escrow (vault PDA is authority)
    token_2022::burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            Burn {
                mint: ctx.accounts.shares_mint.to_account_info(),
                from: ctx.accounts.share_escrow.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        shares_locked,
    )?;

    // 6. CREATE CLAIMABLE TOKENS ACCOUNT (per-user, vault-owned)
    // This is a token account for the asset_mint, owned by vault PDA.
    // Handles grief attack: if someone pre-funds the PDA with lamports,
    // create_account will fail. We detect this and use allocate + assign instead.
    let claimable_tokens_bump = ctx.bumps.claimable_tokens;
    let claimable_tokens_bump_bytes = [claimable_tokens_bump];
    let claimable_tokens_seeds: &[&[u8]] = &[
        CLAIMABLE_TOKENS_SEED,
        vault_key.as_ref(),
        owner.as_ref(),
        &claimable_tokens_bump_bytes,
    ];

    let token_account_size = SPL_TOKEN_ACCOUNT_SIZE;
    let rent = &ctx.accounts.rent;
    let required_lamports = rent.minimum_balance(token_account_size);
    let claimable_info = ctx.accounts.claimable_tokens.to_account_info();
    let existing_lamports = claimable_info.lamports();
    let claimable_data_len = claimable_info.data_len();

    if claimable_data_len == 0 && existing_lamports < required_lamports {
        // Account either doesn't exist or was grief-funded with insufficient lamports.
        // Top up lamports if needed, then allocate + assign (or create_account if empty).
        if existing_lamports == 0 {
            // Normal path: account doesn't exist yet
            invoke_signed(
                &anchor_lang::solana_program::system_instruction::create_account(
                    &ctx.accounts.operator.key(),
                    &ctx.accounts.claimable_tokens.key(),
                    required_lamports,
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
        } else {
            // Grief path: account has lamports but no data.
            // Transfer remaining rent, allocate space, assign to token program.
            let lamports_needed = required_lamports.saturating_sub(existing_lamports);
            if lamports_needed > 0 {
                invoke_signed(
                    &anchor_lang::solana_program::system_instruction::transfer(
                        &ctx.accounts.operator.key(),
                        &ctx.accounts.claimable_tokens.key(),
                        lamports_needed,
                    ),
                    &[
                        ctx.accounts.operator.to_account_info(),
                        ctx.accounts.claimable_tokens.to_account_info(),
                        ctx.accounts.system_program.to_account_info(),
                    ],
                    &[],
                )?;
            }
            invoke_signed(
                &anchor_lang::solana_program::system_instruction::allocate(
                    &ctx.accounts.claimable_tokens.key(),
                    token_account_size as u64,
                ),
                &[
                    ctx.accounts.claimable_tokens.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[claimable_tokens_seeds],
            )?;
            invoke_signed(
                &anchor_lang::solana_program::system_instruction::assign(
                    &ctx.accounts.claimable_tokens.key(),
                    &ctx.accounts.asset_token_program.key(),
                ),
                &[
                    ctx.accounts.claimable_tokens.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[claimable_tokens_seeds],
            )?;
        }

        // Initialize the token account with vault as owner.
        // Use the matching instruction builder for the asset's token program.
        let asset_mint_key_ref = ctx.accounts.asset_mint.key();
        let asset_program_key = ctx.accounts.asset_token_program.key();
        let init_ix = if asset_program_key == anchor_spl::token::ID {
            spl_token::instruction::initialize_account3(
                &asset_program_key,
                &ctx.accounts.claimable_tokens.key(),
                &asset_mint_key_ref,
                &vault_key,
            )?
        } else {
            spl_token_2022::instruction::initialize_account3(
                &asset_program_key,
                &ctx.accounts.claimable_tokens.key(),
                &asset_mint_key_ref,
                &vault_key,
            )?
        };

        invoke_signed(
            &init_ix,
            &[
                ctx.accounts.claimable_tokens.to_account_info(),
                ctx.accounts.asset_mint.to_account_info(),
                ctx.accounts.asset_token_program.to_account_info(),
            ],
            &[claimable_tokens_seeds],
        )?;
    }
    // If data_len > 0, account is already initialized (e.g., previous unfulfilled redeem).
    // This should not happen because ClaimableEscrow uses `init` which prevents double-init.

    // 7. TRANSFER ASSETS from asset_vault to claimable_tokens
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.asset_vault.to_account_info(),
                to: ctx.accounts.claimable_tokens.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        assets_claimable,
        ctx.accounts.asset_mint.decimals,
    )?;

    // 8. INIT CLAIMABLE ESCROW PDA
    let claimable_escrow = &mut ctx.accounts.claimable_escrow;
    claimable_escrow.vault = vault_key;
    claimable_escrow.owner = owner;
    claimable_escrow.amount = assets_claimable;
    claimable_escrow.bump = ctx.bumps.claimable_escrow;

    // 9. UPDATE VAULT STATE
    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault
        .total_assets
        .checked_sub(assets_claimable)
        .ok_or(VaultError::InsufficientAssets)?;
    vault.total_shares = vault
        .total_shares
        .checked_sub(shares_locked)
        .ok_or(VaultError::InsufficientShares)?;

    // 10. UPDATE REQUEST STATE
    let redeem_request = &mut ctx.accounts.redeem_request;
    redeem_request.assets_claimable = assets_claimable;
    redeem_request.status = RequestStatus::Fulfilled;
    redeem_request.fulfilled_at = Clock::get()?.unix_timestamp;

    // 11. EMIT EVENT
    emit!(RedeemFulfilled {
        vault: vault_key,
        owner,
        shares: shares_locked,
        assets: assets_claimable,
    });

    Ok(())
}
