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
    events::RedemptionApproved,
    instructions::oracle_lookup::{check_not_frozen, find_oracle_price, validate_attestation},
    state::{ClaimableEscrow, CreditVault, RedemptionRequest, RedemptionStatus},
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct ApproveRedeem<'info> {
    #[account(mut)]
    pub manager: Signer<'info>,

    #[account(
        mut,
        constraint = vault.manager == manager.key() @ VaultError::Unauthorized,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, CreditVault>,

    #[account(
        mut,
        has_one = vault,
        seeds = [REDEMPTION_REQUEST_SEED, vault.key().as_ref(), redemption_request.investor.as_ref()],
        bump = redemption_request.bump,
    )]
    pub redemption_request: Account<'info, RedemptionRequest>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = redemption_escrow.key() == vault.redemption_escrow,
    )]
    pub redemption_escrow: InterfaceAccount<'info, TokenAccount>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = deposit_vault.key() == vault.deposit_vault,
    )]
    pub deposit_vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Per-user claimable token account, created via CPI
    #[account(
        mut,
        seeds = [CLAIMABLE_TOKENS_SEED, vault.key().as_ref(), redemption_request.investor.as_ref()],
        bump
    )]
    pub claimable_tokens: UncheckedAccount<'info>,

    #[account(
        init,
        payer = manager,
        space = ClaimableEscrow::LEN,
        seeds = [CLAIMABLE_SEED, vault.key().as_ref(), redemption_request.investor.as_ref()],
        bump
    )]
    pub claimable_escrow: Account<'info, ClaimableEscrow>,

    /// CHECK: FrozenAccount PDA — validated in handler
    #[account(
        seeds = [FROZEN_ACCOUNT_SEED, vault.key().as_ref(), redemption_request.investor.as_ref()],
        bump
    )]
    pub frozen_account: UncheckedAccount<'info>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<ApproveRedeem>) -> Result<()> {
    let request = &ctx.accounts.redemption_request;

    require!(
        request.status == RedemptionStatus::Pending,
        VaultError::RequestNotPending
    );

    let vault = &ctx.accounts.vault;
    let vault_key = vault.key();
    let shares_locked = request.shares_locked;

    // Re-validate attestation at approval time (spec §8.3)
    let clock = Clock::get()?;
    validate_attestation(
        ctx.remaining_accounts,
        &vault.attestation_program,
        &request.investor,
        &vault.attester,
        &clock,
    )?;

    // Check not frozen
    check_not_frozen(&ctx.accounts.frozen_account.to_account_info())?;

    // Oracle is REQUIRED for SVS-11
    let (price, updated_at) = find_oracle_price(
        ctx.remaining_accounts,
        &vault.oracle_program,
        &vault.nav_oracle,
        &vault_key,
    )?
    .ok_or(VaultError::OracleRequired)?;

    svs_oracle::validate_oracle(price, updated_at, clock.unix_timestamp, vault.max_staleness)
        .map_err(|e| match e {
            svs_oracle::OracleError::StalePrice => VaultError::StaleOraclePrice,
            svs_oracle::OracleError::InvalidPrice => VaultError::InvalidOraclePrice,
            svs_oracle::OracleError::MathOverflow => VaultError::MathOverflow,
            svs_oracle::OracleError::UnauthorizedUpdate => VaultError::Unauthorized,
            svs_oracle::OracleError::PriceDeviationExceeded => VaultError::InvalidOraclePrice,
        })?;

    // assets = shares_locked * nav_per_share / 10^share_decimals (floor)
    let gross_assets = svs_oracle::shares_to_assets(shares_locked, price).map_err(|e| match e {
        svs_oracle::OracleError::MathOverflow => VaultError::MathOverflow,
        _ => VaultError::InvalidOraclePrice,
    })?;

    // Apply module hooks if enabled
    #[cfg(feature = "modules")]
    let assets = {
        let remaining = ctx.remaining_accounts;
        module_hooks::check_deposit_access(
            remaining,
            &crate::ID,
            &vault_key,
            &request.investor,
            &[],
        )?;
        let result = module_hooks::apply_exit_fee(remaining, &crate::ID, &vault_key, gross_assets)?;
        result.net_assets
    };

    #[cfg(not(feature = "modules"))]
    let assets = gross_assets;

    require!(assets > 0, VaultError::ZeroAmount);
    require!(
        ctx.accounts.deposit_vault.amount >= assets,
        VaultError::InsufficientLiquidity
    );

    let asset_mint_key = vault.asset_mint;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let vault_bump = vault.bump;
    let vault_signer_seeds: &[&[&[u8]]] = &[&[
        CREDIT_VAULT_SEED,
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
                from: ctx.accounts.redemption_escrow.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            vault_signer_seeds,
        ),
        shares_locked,
    )?;

    // Create per-user claimable_tokens account (handles pre-funded PDAs)
    let claimable_tokens_bump = ctx.bumps.claimable_tokens;
    let investor_key = request.investor;
    let claimable_tokens_seeds: &[&[u8]] = &[
        CLAIMABLE_TOKENS_SEED,
        vault_key.as_ref(),
        investor_key.as_ref(),
        &[claimable_tokens_bump],
    ];

    let token_account_size = spl_token_2022::state::Account::LEN;
    let rent = &ctx.accounts.rent;
    let lamports = rent.minimum_balance(token_account_size);
    let claimable_tokens_info = ctx.accounts.claimable_tokens.to_account_info();

    if claimable_tokens_info.lamports() > 0 {
        let deficit = lamports.saturating_sub(claimable_tokens_info.lamports());
        if deficit > 0 {
            anchor_lang::solana_program::program::invoke(
                &anchor_lang::solana_program::system_instruction::transfer(
                    &ctx.accounts.manager.key(),
                    &ctx.accounts.claimable_tokens.key(),
                    deficit,
                ),
                &[
                    ctx.accounts.manager.to_account_info(),
                    claimable_tokens_info.clone(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }
        invoke_signed(
            &anchor_lang::solana_program::system_instruction::allocate(
                &ctx.accounts.claimable_tokens.key(),
                token_account_size as u64,
            ),
            &[claimable_tokens_info.clone()],
            &[claimable_tokens_seeds],
        )?;
        invoke_signed(
            &anchor_lang::solana_program::system_instruction::assign(
                &ctx.accounts.claimable_tokens.key(),
                &ctx.accounts.asset_token_program.key(),
            ),
            &[claimable_tokens_info.clone()],
            &[claimable_tokens_seeds],
        )?;
    } else {
        invoke_signed(
            &anchor_lang::solana_program::system_instruction::create_account(
                &ctx.accounts.manager.key(),
                &ctx.accounts.claimable_tokens.key(),
                lamports,
                token_account_size as u64,
                &ctx.accounts.asset_token_program.key(),
            ),
            &[
                ctx.accounts.manager.to_account_info(),
                claimable_tokens_info.clone(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[claimable_tokens_seeds],
        )?;
    }

    invoke_signed(
        &spl_token_2022::instruction::initialize_account3(
            &ctx.accounts.asset_token_program.key(),
            &ctx.accounts.claimable_tokens.key(),
            &asset_mint_key,
            &vault_key,
        )?,
        &[
            claimable_tokens_info,
            ctx.accounts.asset_mint.to_account_info(),
        ],
        &[claimable_tokens_seeds],
    )?;

    // Transfer assets from deposit_vault to claimable_tokens
    // Record balance before transfer for delta-based T22 fee accounting
    let deposit_vault_before = ctx.accounts.deposit_vault.amount;

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.deposit_vault.to_account_info(),
                to: ctx.accounts.claimable_tokens.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            vault_signer_seeds,
        ),
        assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    // Delta-based accounting: actual amount sent may differ from `assets` due to T22 transfer fees
    ctx.accounts.deposit_vault.reload()?;
    let actual_sent = deposit_vault_before
        .checked_sub(ctx.accounts.deposit_vault.amount)
        .ok_or(VaultError::MathOverflow)?;

    // Update vault totals using actual amount debited
    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault
        .total_assets
        .checked_sub(actual_sent)
        .ok_or(VaultError::MathOverflow)?;
    vault.total_shares = vault
        .total_shares
        .checked_sub(shares_locked)
        .ok_or(VaultError::MathOverflow)?;

    // Set claimable escrow state — use actual_sent (what left the vault)
    // The claimable_tokens account received actual_sent minus any receiver-side fee,
    // but claim_redemption transfers whatever is in the account, so this is safe.
    let claimable_escrow = &mut ctx.accounts.claimable_escrow;
    claimable_escrow.investor = investor_key;
    claimable_escrow.vault = vault.key();
    claimable_escrow.amount_claimable = actual_sent;
    claimable_escrow.bump = ctx.bumps.claimable_escrow;

    // Update request
    let request = &mut ctx.accounts.redemption_request;
    request.amount_claimable = assets;
    request.status = RedemptionStatus::Approved;

    emit!(RedemptionApproved {
        vault: vault.key(),
        investor: investor_key,
        shares: shares_locked,
        assets,
        nav: price,
    });

    Ok(())
}
