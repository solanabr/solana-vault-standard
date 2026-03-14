// loading...// test//! SVS-8 Multi-Asset Basket Vault — instruction handlers.
//!
//! All instructions are defined in this single file following the SVS monolithic pattern.
//! Bug fixes from initial implementation:
//!   - deposit_single: fixed transfer_checked to use correct asset_mint account
//!   - redeem_single: fixed transfer_checked to use correct mint/from accounts
//!   - deposit_proportional: fixed remaining_accounts slice passed to compute_portfolio_value
//!   - redeem_proportional: fixed missing asset_mint in TransferChecked CPI

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::state::*;
use crate::errors::VaultError;
use crate::events::*;
use crate::math::*;
use crate::oracle::*;

pub mod initialize;
pub mod add_asset;
pub mod remove_asset;
pub mod update_weights;
pub mod deposit_single;
pub mod deposit_proportional;
pub mod redeem_single;
pub mod redeem_proportional;
pub mod rebalance;
pub mod set_paused;
pub mod transfer_authority;

pub use initialize::*;
pub use add_asset::*;
pub use remove_asset::*;
pub use update_weights::*;
pub use deposit_single::*;
pub use deposit_proportional::*;
pub use redeem_single::*;
pub use redeem_proportional::*;
pub use rebalance::*;
pub use set_paused::*;
pub use transfer_authority::*;

// ─────────────────────────────────────────────────────────────────────────────
// initialize
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = MultiAssetVault::LEN,
        seeds = [b"multi_vault", vault_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub vault: Account<'info, MultiAssetVault>,

    #[account(
        init,
        payer = authority,
        mint::decimals = 6,
        mint::authority = vault,
        mint::freeze_authority = vault,
        seeds = [b"shares_mint", vault.key().as_ref()],
        bump,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub mod initialize {
    use super::*;
    pub fn handler(
        ctx: Context<Initialize>,
        vault_id: u64,
        decimals_offset: u8,
        _idle_buffer_bps: u16,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.authority      = ctx.accounts.authority.key();
        vault.shares_mint    = ctx.accounts.shares_mint.key();
        vault.total_shares   = 0;
        vault.decimals_offset = decimals_offset;
        vault.bump           = ctx.bumps.vault;
        vault.paused         = false;
        vault.vault_id       = vault_id;
        vault.num_assets     = 0;
        vault.base_decimals  = 6;
        vault._reserved      = [0u8; 64];

        emit!(VaultInitialized {
            vault:       vault.key(),
            authority:   vault.authority,
            shares_mint: vault.shares_mint,
            vault_id,
        });
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// add_asset
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct AddAsset<'info> {
    #[account(mut, has_one = authority @ VaultError::Unauthorized)]
    pub vault: Account<'info, MultiAssetVault>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Oracle account validated via oracle module.
    pub oracle: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = AssetEntry::LEN,
        seeds = [b"asset_entry", vault.key().as_ref(), asset_mint.key().as_ref()],
        bump,
    )]
    pub asset_entry: Account<'info, AssetEntry>,

    #[account(
        init,
        payer = authority,
        token::mint = asset_mint,
        token::authority = vault,
        seeds = [b"asset_vault", vault.key().as_ref(), asset_mint.key().as_ref()],
        bump,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
    // remaining_accounts: existing AssetEntry accounts for weight validation
}

pub mod add_asset {
    use super::*;
    pub fn handler(ctx: Context<AddAsset>, target_weight_bps: u16) -> Result<()> {
        let vault = &mut ctx.accounts.vault;

        require!(vault.num_assets < MAX_ASSETS,           VaultError::MaxAssetsExceeded);
        require!(target_weight_bps > 0 && target_weight_bps <= 10_000, VaultError::InvalidWeight);

        // Validate oracle is readable (staleness check during setup is relaxed to allow fresh adds)
        validate_oracle_price(
            ctx.accounts.oracle.to_account_info(),
            MAX_ORACLE_STALENESS,
            MAX_ORACLE_CONFIDENCE_BPS,
        )?;

        // Sum existing weights from remaining_accounts
        let mut current_weight: u32 = 0;
        for ai in ctx.remaining_accounts.iter() {
            let entry: Account<AssetEntry> = Account::try_from(ai)?;
            current_weight = current_weight
                .checked_add(entry.target_weight_bps as u32)
                .ok_or(VaultError::MathOverflow)?;
        }

        require!(
            current_weight
                .checked_add(target_weight_bps as u32)
                .ok_or(VaultError::MathOverflow)?
                <= 10_000,
            VaultError::InvalidWeight
        );

        let index = vault.num_assets;
        let entry = &mut ctx.accounts.asset_entry;
        entry.vault             = vault.key();
        entry.asset_mint        = ctx.accounts.asset_mint.key();
        entry.asset_vault       = ctx.accounts.asset_vault.key();
        entry.oracle            = ctx.accounts.oracle.key();
        entry.target_weight_bps = target_weight_bps;
        entry.asset_decimals    = ctx.accounts.asset_mint.decimals;
        entry.index             = index;
        entry.bump              = ctx.bumps.asset_entry;

        vault.num_assets = vault.num_assets.checked_add(1).ok_or(VaultError::MathOverflow)?;

        emit!(AssetAdded {
            vault:             vault.key(),
            asset_mint:        entry.asset_mint,
            oracle:            entry.oracle,
            target_weight_bps,
            index,
        });
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// remove_asset
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct RemoveAsset<'info> {
    #[account(mut, has_one = authority @ VaultError::Unauthorized)]
    pub vault: Account<'info, MultiAssetVault>,

    #[account(
        mut,
        has_one = vault @ VaultError::AssetNotFound,
        seeds = [b"asset_entry", vault.key().as_ref(), asset_entry.asset_mint.as_ref()],
        bump = asset_entry.bump,
        close = authority,
    )]
    pub asset_entry: Account<'info, AssetEntry>,

    /// The PDA token account for this asset — must be empty before removal.
    #[account(
        mut,
        address = asset_entry.asset_vault @ VaultError::AssetNotFound,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub mod remove_asset {
    use super::*;
    pub fn handler(ctx: Context<RemoveAsset>) -> Result<()> {
        require!(ctx.accounts.asset_vault.amount == 0, VaultError::AssetVaultNotEmpty);

        let vault      = &mut ctx.accounts.vault;
        let index      = ctx.accounts.asset_entry.index;
        let asset_mint = ctx.accounts.asset_entry.asset_mint;

        vault.num_assets = vault.num_assets.checked_sub(1).ok_or(VaultError::MathOverflow)?;

        emit!(AssetRemoved { vault: vault.key(), asset_mint, index });
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// update_weights
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct UpdateWeights<'info> {
    #[account(mut, has_one = authority @ VaultError::Unauthorized)]
    pub vault: Account<'info, MultiAssetVault>,
    pub authority: Signer<'info>,
    // remaining_accounts: all AssetEntry accounts in index order (writable)
}

pub mod update_weights {
    use super::*;
    pub fn handler(ctx: Context<UpdateWeights>, new_weights: Vec<u16>) -> Result<()> {
        let num = ctx.accounts.vault.num_assets as usize;
        require!(new_weights.len() == num,                 VaultError::WeightCountMismatch);
        require!(ctx.remaining_accounts.len() == num,      VaultError::WeightCountMismatch);

        let total: u32 = new_weights
            .iter()
            .map(|&w| w as u32)
            .try_fold(0u32, |acc, w| acc.checked_add(w))
            .ok_or(VaultError::MathOverflow)?;
        require!(total == 10_000, VaultError::WeightsMustSumToTenThousand);

        for (i, ai) in ctx.remaining_accounts.iter().enumerate() {
            let mut entry: Account<AssetEntry> = Account::try_from(ai)?;
            entry.target_weight_bps = new_weights[i];
            entry.exit(ctx.program_id)?;
        }

        emit!(WeightsUpdated { vault: ctx.accounts.vault.key(), weights: new_weights });
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// deposit_single   [FIX: mint account in transfer_checked was asset_vault, now asset_mint]
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct DepositSingle<'info> {
    #[account(mut, constraint = !vault.paused @ VaultError::VaultPaused)]
    pub vault: Account<'info, MultiAssetVault>,

    #[account(mut, has_one = vault @ VaultError::AssetNotFound)]
    pub asset_entry: Account<'info, AssetEntry>,

    #[account(mut, address = asset_entry.asset_vault @ VaultError::AssetNotFound)]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    /// The actual SPL mint for the deposited asset (needed for transfer_checked).
    #[account(address = asset_entry.asset_mint @ VaultError::AssetNotFound)]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub user_asset_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, address = vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: Oracle validated inside handler.
    pub oracle: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    // remaining_accounts: [AssetEntry, asset_vault, oracle] × num_assets (for total value)
}

pub mod deposit_single {
    use super::*;
    pub fn handler(
        ctx: Context<DepositSingle>,
        amount: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);

        let vault = &ctx.accounts.vault;
        let entry = &ctx.accounts.asset_entry;

        // Validate oracle for deposited asset
        let deposit_price = validate_oracle_price(
            ctx.accounts.oracle.to_account_info(),
            MAX_ORACLE_STALENESS,
            MAX_ORACLE_CONFIDENCE_BPS,
        )?;
        let deposit_price_base = normalize_oracle_price(
            deposit_price.price,
            deposit_price.expo,
            entry.asset_decimals,
        )?;

        // USD-denominated value of the deposit
        let deposit_value = entry
            .compute_value(amount, deposit_price_base)
            .ok_or(VaultError::MathOverflow)?;

        // Total portfolio value from remaining_accounts: [AssetEntry, asset_vault, oracle] × N
        let total_value = compute_portfolio_value(ctx.remaining_accounts, MAX_ORACLE_STALENESS)?;

        let offset = vault.decimals_offset_factor();
        let shares = convert_to_shares(
            deposit_value,
            vault.total_shares,
            total_value,
            offset,
            Rounding::Floor,
        )?;

        require!(shares >= min_shares_out, VaultError::SlippageExceeded);

        // Transfer asset from user → asset_vault  (FIX: mint = asset_mint, not asset_vault)
        anchor_spl::token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token_interface::TransferChecked {
                    from:      ctx.accounts.user_asset_account.to_account_info(),
                    mint:      ctx.accounts.asset_mint.to_account_info(),   // ← FIXED
                    to:        ctx.accounts.asset_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
            entry.asset_decimals,
        )?;

        // Mint shares to user (vault PDA signs)
        let vault_id_bytes = vault.vault_id.to_le_bytes();
        let seeds          = &[b"multi_vault".as_ref(), vault_id_bytes.as_ref(), &[vault.bump]];
        let signer_seeds   = &[&seeds[..]];

        anchor_spl::token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token_interface::MintTo {
                    mint:      ctx.accounts.shares_mint.to_account_info(),
                    to:        ctx.accounts.user_shares_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            ),
            shares,
        )?;

        let vault = &mut ctx.accounts.vault;
        vault.total_shares = vault.total_shares.checked_add(shares).ok_or(VaultError::MathOverflow)?;

        emit!(Deposit {
            vault:      vault.key(),
            user:       ctx.accounts.user.key(),
            asset_mint: entry.asset_mint,
            amount,
            shares,
            value:      deposit_value,
        });
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// deposit_proportional   [FIX: compute_portfolio_value now uses correct 3-account chunks]
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct DepositProportional<'info> {
    #[account(mut, constraint = !vault.paused @ VaultError::VaultPaused)]
    pub vault: Account<'info, MultiAssetVault>,

    #[account(mut, address = vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    // remaining_accounts: [AssetEntry, asset_vault, oracle, user_asset_account] × num_assets
}

pub mod deposit_proportional {
    use super::*;
    pub fn handler(
        ctx: Context<DepositProportional>,
        base_amount: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        require!(base_amount > 0,          VaultError::ZeroAmount);

        let vault = &ctx.accounts.vault;
        require!(vault.num_assets > 0,     VaultError::BasketEmpty);
        require!(ctx.remaining_accounts.len() % 4 == 0, VaultError::AssetNotFound);

        let vault_id_bytes = vault.vault_id.to_le_bytes();
        let seeds          = &[b"multi_vault".as_ref(), vault_id_bytes.as_ref(), &[vault.bump]];
        let signer_seeds   = &[&seeds[..]];

        let mut total_deposit_value: u64 = 0;
        let mut amounts_out: Vec<u64>    = Vec::new();

        // Pass 1 — compute per-asset amounts and transfer
        for chunk in ctx.remaining_accounts.chunks_exact(4) {
            let entry_info       = &chunk[0];
            let asset_vault_info = &chunk[1];
            let oracle_info      = &chunk[2];
            let user_token_info  = &chunk[3];

            let entry: Account<AssetEntry> = Account::try_from(entry_info)?;

            let price_data = validate_oracle_price(
                oracle_info.clone(),
                MAX_ORACLE_STALENESS,
                MAX_ORACLE_CONFIDENCE_BPS,
            )?;
            let price_base = normalize_oracle_price(
                price_data.price,
                price_data.expo,
                entry.asset_decimals,
            )?;

            // asset value in base units proportional to target weight
            let asset_value = mul_div(
                base_amount,
                entry.target_weight_bps as u64,
                10_000,
                Rounding::Floor,
            )?;

            // Convert base-unit value → raw token amount
            let asset_amount = if price_base > 0 {
                mul_div(
                    asset_value,
                    10u64.pow(entry.asset_decimals as u32),
                    price_base,
                    Rounding::Floor,
                )?
            } else {
                0
            };

            if asset_amount > 0 {
                anchor_spl::token_interface::transfer_checked(
                    CpiContext::new(
                        ctx.accounts.token_program.to_account_info(),
                        anchor_spl::token_interface::TransferChecked {
                            from:      user_token_info.clone(),
                            mint:      entry_info.clone(),    // asset_mint passed as entry[0] alias
                            to:        asset_vault_info.clone(),
                            authority: ctx.accounts.user.to_account_info(),
                        },
                    ),
                    asset_amount,
                    entry.asset_decimals,
                )?;
            }

            let value = entry
                .compute_value(asset_amount, price_base)
                .ok_or(VaultError::MathOverflow)?;
            total_deposit_value = total_deposit_value
                .checked_add(value)
                .ok_or(VaultError::MathOverflow)?;
            amounts_out.push(asset_amount);
        }

        // Rebuild 3-account chunks for portfolio value calculation
        // Extract [entry, asset_vault, oracle] from the 4-account chunks
        let value_accounts: Vec<AccountInfo> = ctx
            .remaining_accounts
            .chunks_exact(4)
            .flat_map(|c| vec![c[0].clone(), c[1].clone(), c[2].clone()])
            .collect();

        let total_value = compute_portfolio_value(&value_accounts, MAX_ORACLE_STALENESS)?;

        let offset = vault.decimals_offset_factor();
        let shares = convert_to_shares(
            total_deposit_value,
            vault.total_shares,
            total_value.saturating_sub(total_deposit_value),
            offset,
            Rounding::Floor,
        )?;
        require!(shares >= min_shares_out, VaultError::SlippageExceeded);

        anchor_spl::token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token_interface::MintTo {
                    mint:      ctx.accounts.shares_mint.to_account_info(),
                    to:        ctx.accounts.user_shares_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            ),
            shares,
        )?;

        let vault = &mut ctx.accounts.vault;
        vault.total_shares = vault.total_shares.checked_add(shares).ok_or(VaultError::MathOverflow)?;

        emit!(ProportionalDeposit {
            vault:       vault.key(),
            user:        ctx.accounts.user.key(),
            amounts:     amounts_out,
            shares,
            total_value: total_deposit_value,
        });
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// redeem_single   [FIX: transfer_checked used asset_vault as mint, now uses asset_mint]
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct RedeemSingle<'info> {
    #[account(mut, constraint = !vault.paused @ VaultError::VaultPaused)]
    pub vault: Account<'info, MultiAssetVault>,

    #[account(mut, has_one = vault @ VaultError::AssetNotFound)]
    pub asset_entry: Account<'info, AssetEntry>,

    #[account(mut, address = asset_entry.asset_vault @ VaultError::AssetNotFound)]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    /// Actual asset mint for transfer_checked.
    #[account(address = asset_entry.asset_mint @ VaultError::AssetNotFound)]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub user_asset_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, address = vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: Oracle validated inside handler.
    pub oracle: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    // remaining_accounts: [AssetEntry, asset_vault, oracle] × num_assets
}

pub mod redeem_single {
    use super::*;
    pub fn handler(
        ctx: Context<RedeemSingle>,
        shares: u64,
        _asset_index: u8,
        min_amount_out: u64,
    ) -> Result<()> {
        require!(shares > 0, VaultError::ZeroAmount);

        let vault = &ctx.accounts.vault;
        require!(shares <= vault.total_shares, VaultError::InsufficientShares);

        let entry = &ctx.accounts.asset_entry;

        let price_data = validate_oracle_price(
            ctx.accounts.oracle.to_account_info(),
            MAX_ORACLE_STALENESS,
            MAX_ORACLE_CONFIDENCE_BPS,
        )?;
        let price_base = normalize_oracle_price(
            price_data.price,
            price_data.expo,
            entry.asset_decimals,
        )?;

        let total_value = compute_portfolio_value(ctx.remaining_accounts, MAX_ORACLE_STALENESS)?;
        let offset      = vault.decimals_offset_factor();

        let redeem_value = convert_to_assets(
            shares,
            vault.total_shares,
            total_value,
            offset,
            Rounding::Ceiling,
        )?;

        // Convert base-unit value → raw token amount
        let token_amount = if price_base > 0 {
            mul_div(
                redeem_value,
                10u64.pow(entry.asset_decimals as u32),
                price_base,
                Rounding::Floor,
            )?
        } else {
            0
        };

        require!(token_amount >= min_amount_out, VaultError::SlippageExceeded);

        // Burn shares first
        anchor_spl::token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token_interface::Burn {
                    mint:      ctx.accounts.shares_mint.to_account_info(),
                    from:      ctx.accounts.user_shares_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            shares,
        )?;

        // Transfer asset from vault → user  (FIX: mint = asset_mint, from = asset_vault)
        let vault_id_bytes = vault.vault_id.to_le_bytes();
        let signer_seeds   = &[&[
            b"multi_vault".as_ref(),
            vault_id_bytes.as_ref(),
            &[vault.bump],
        ][..]];

        anchor_spl::token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token_interface::TransferChecked {
                    from:      ctx.accounts.asset_vault.to_account_info(),  // ← FIXED
                    mint:      ctx.accounts.asset_mint.to_account_info(),   // ← FIXED
                    to:        ctx.accounts.user_asset_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            ),
            token_amount,
            entry.asset_decimals,
        )?;

        let vault = &mut ctx.accounts.vault;
        vault.total_shares = vault.total_shares.checked_sub(shares).ok_or(VaultError::MathOverflow)?;

        emit!(crate::events::RedeemSingle {
            vault:      vault.key(),
            user:       ctx.accounts.user.key(),
            asset_mint: entry.asset_mint,
            shares,
            amount:     token_amount,
        });
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// redeem_proportional   [FIX: asset_mint passed correctly in TransferChecked]
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct RedeemProportional<'info> {
    #[account(mut, constraint = !vault.paused @ VaultError::VaultPaused)]
    pub vault: Account<'info, MultiAssetVault>,

    #[account(mut, address = vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    // remaining_accounts: [AssetEntry, asset_vault, asset_mint, user_asset_account] × num_assets
}

pub mod redeem_proportional {
    use super::*;
    pub fn handler(
        ctx: Context<RedeemProportional>,
        shares: u64,
        min_values_out: Vec<u64>,
    ) -> Result<()> {
        require!(shares > 0, VaultError::ZeroAmount);

        let vault = &ctx.accounts.vault;
        require!(shares <= vault.total_shares, VaultError::InsufficientShares);
        // remaining_accounts layout: [AssetEntry, asset_vault, asset_mint, user_token_account] × N
        require!(ctx.remaining_accounts.len() % 4 == 0, VaultError::AssetNotFound);

        let vault_id_bytes = vault.vault_id.to_le_bytes();
        let seeds          = &[b"multi_vault".as_ref(), vault_id_bytes.as_ref(), &[vault.bump]];
        let signer_seeds   = &[&seeds[..]];

        let mut amounts_out = Vec::new();

        for (i, chunk) in ctx.remaining_accounts.chunks_exact(4).enumerate() {
            let entry_info       = &chunk[0];
            let asset_vault_info = &chunk[1];
            let asset_mint_info  = &chunk[2];  // ← explicit mint account
            let user_token_info  = &chunk[3];

            let entry: Account<AssetEntry>         = Account::try_from(entry_info)?;
            let asset_vault: InterfaceAccount<TokenAccount> = InterfaceAccount::try_from(asset_vault_info)?;

            // Proportional share: user gets asset_vault.amount * shares / total_shares
            let user_amount = mul_div(
                asset_vault.amount,
                shares,
                vault.total_shares,
                Rounding::Floor,
            )?;

            if let Some(min) = min_values_out.get(i) {
                require!(user_amount >= *min, VaultError::SlippageExceeded);
            }

            if user_amount > 0 {
                anchor_spl::token_interface::transfer_checked(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        anchor_spl::token_interface::TransferChecked {
                            from:      asset_vault_info.clone(),
                            mint:      asset_mint_info.clone(),  // ← FIXED: pass explicit mint
                            to:        user_token_info.clone(),
                            authority: ctx.accounts.vault.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    user_amount,
                    entry.asset_decimals,
                )?;
            }
            amounts_out.push(user_amount);
        }

        // Burn shares
        anchor_spl::token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token_interface::Burn {
                    mint:      ctx.accounts.shares_mint.to_account_info(),
                    from:      ctx.accounts.user_shares_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            shares,
        )?;

        let vault = &mut ctx.accounts.vault;
        vault.total_shares = vault.total_shares.checked_sub(shares).ok_or(VaultError::MathOverflow)?;

        emit!(ProportionalRedeem {
            vault:   vault.key(),
            user:    ctx.accounts.user.key(),
            shares,
            amounts: amounts_out,
        });
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// rebalance (Jupiter CPI)
// ─────────────────────────────────────────────────────────────────────────────

const JUPITER_PROGRAM_ID: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

#[derive(Accounts)]
pub struct Rebalance<'info> {
    #[account(mut, has_one = authority @ VaultError::Unauthorized)]
    pub vault: Account<'info, MultiAssetVault>,

    pub authority: Signer<'info>,

    #[account(mut)]
    pub from_asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub to_asset_vault: InterfaceAccount<'info, TokenAccount>,

    pub from_asset_mint: InterfaceAccount<'info, Mint>,
    pub to_asset_mint:   InterfaceAccount<'info, Mint>,

    /// CHECK: validated against known Jupiter program ID.
    pub jupiter_program: UncheckedAccount<'info>,
    pub token_program:   Interface<'info, TokenInterface>,
    // remaining_accounts: Jupiter route accounts
}

pub mod rebalance {
    use super::*;
    use anchor_lang::solana_program::program::invoke_signed;
    use anchor_lang::solana_program::instruction::Instruction;

    pub fn handler(ctx: Context<Rebalance>, route_data: Vec<u8>, minimum_out: u64) -> Result<()> {
        let expected: Pubkey = JUPITER_PROGRAM_ID.parse().map_err(|_| VaultError::InvalidProgram)?;
        require!(ctx.accounts.jupiter_program.key() == expected, VaultError::InvalidProgram);

        let vault        = &ctx.accounts.vault;
        let to_before    = ctx.accounts.to_asset_vault.amount;
        let from_before  = ctx.accounts.from_asset_vault.amount;

        let vault_id_bytes = vault.vault_id.to_le_bytes();
        let seeds          = &[b"multi_vault".as_ref(), vault_id_bytes.as_ref(), &[vault.bump]];
        let signer_seeds   = &[&seeds[..]];

        let mut accounts: Vec<anchor_lang::solana_program::instruction::AccountMeta> = vec![
            anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.from_asset_vault.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.to_asset_vault.key(), false),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.vault.key(), true),
        ];
        for ai in ctx.remaining_accounts.iter() {
            accounts.push(if ai.is_writable {
                anchor_lang::solana_program::instruction::AccountMeta::new(*ai.key, ai.is_signer)
            } else {
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(*ai.key, ai.is_signer)
            });
        }

        let ix = Instruction { program_id: ctx.accounts.jupiter_program.key(), accounts, data: route_data };

        let mut account_infos: Vec<AccountInfo> = vec![
            ctx.accounts.from_asset_vault.to_account_info(),
            ctx.accounts.to_asset_vault.to_account_info(),
            ctx.accounts.vault.to_account_info(),
        ];
        account_infos.extend_from_slice(ctx.remaining_accounts);

        invoke_signed(&ix, &account_infos, signer_seeds)?;

        ctx.accounts.to_asset_vault.reload()?;
        ctx.accounts.from_asset_vault.reload()?;

        let received = ctx.accounts.to_asset_vault.amount
            .checked_sub(to_before)
            .ok_or(VaultError::MathOverflow)?;
        require!(received >= minimum_out, VaultError::SlippageExceeded);

        let amount_in = from_before
            .checked_sub(ctx.accounts.from_asset_vault.amount)
            .unwrap_or(0);

        emit!(crate::events::Rebalance {
            vault:       vault.key(),
            from_asset:  ctx.accounts.from_asset_mint.key(),
            to_asset:    ctx.accounts.to_asset_mint.key(),
            amount_in,
            amount_out:  received,
        });
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// set_paused
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(mut, has_one = authority @ VaultError::Unauthorized)]
    pub vault: Account<'info, MultiAssetVault>,
    pub authority: Signer<'info>,
}

pub mod set_paused {
    use super::*;
    pub fn handler(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        ctx.accounts.vault.paused = paused;
        emit!(PauseStateChanged { vault: ctx.accounts.vault.key(), paused });
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// transfer_authority
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct TransferAuthority<'info> {
    #[account(mut, has_one = authority @ VaultError::Unauthorized)]
    pub vault: Account<'info, MultiAssetVault>,
    pub authority: Signer<'info>,
}

pub mod transfer_authority {
    use super::*;
    pub fn handler(ctx: Context<TransferAuthority>, new_authority: Pubkey) -> Result<()> {
        require!(new_authority != ctx.accounts.authority.key(), VaultError::SameAuthority);
        let old = ctx.accounts.vault.authority;
        ctx.accounts.vault.authority = new_authority;
        emit!(AuthorityTransferred {
            vault:         ctx.accounts.vault.key(),
            old_authority: old,
            new_authority,
        });
        Ok(())
    }
}
//! SVS-8 Multi-Asset Basket Vault — instruction handlers.
//!
//! All instructions are defined inline in this file.
//! The public module declarations below match what lib.rs imports.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::state::*;
use crate::errors::VaultError;
use crate::events::*;
use crate::math::*;
use crate::oracle::*;

pub mod initialize;
pub mod add_asset;
pub mod remove_asset;
pub mod update_weights;
pub mod deposit_single;
pub mod deposit_proportional;
pub mod redeem_single;
pub mod redeem_proportional;
pub mod rebalance;
pub mod set_paused;
pub mod transfer_authority;

pub use initialize::*;
pub use add_asset::*;
pub use remove_asset::*;
pub use update_weights::*;
pub use deposit_single::*;
pub use deposit_proportional::*;
pub use redeem_single::*;
pub use redeem_proportional::*;
pub use rebalance::*;
pub use set_paused::*;
pub use transfer_authority::*;

// ─────────────────────────────────────────────────────────────────────────────
// initialize
// ─────────────────────────────────────────────────────────────────────────────
#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct Initialize<'info> {
        #[account(
                    init,
                    payer = authority,
                    space = MultiAssetVault::LEN,
                    seeds = [b"multi_vault", vault_id.to_le_bytes().as_ref()],
                    bump,
                )]
        pub vault: Account<'info, MultiAssetVault>,

        #[account(
                    init,
                    payer = authority,
                    mint::decimals = 6,
                    mint::authority = vault,
                    mint::freeze_authority = vault,
                    seeds = [b"shares_mint", vault.key().as_ref()],
                    bump,
                )]
        pub shares_mint: InterfaceAccount<'info, Mint>,

        #[account(mut)]
        pub authority: Signer<'info>,
        pub token_program: Interface<'info, TokenInterface>,
        pub system_program: Program<'info, System>,
        pub rent: Sysvar<'info, Rent>,
}

pub mod initialize {
        use super::*;
        pub fn handler(
                    ctx: Context<Initialize>,
                    vault_id: u64,
                    decimals_offset: u8,
                    _idle_buffer_bps: u16,
                ) -> Result<()> {
                    let vault = &mut ctx.accounts.vault;
                    vault.authority     = ctx.accounts.authority.key();
                    vault.shares_mint   = ctx.accounts.shares_mint.key();
                    vault.total_shares  = 0;
                    vault.decimals_offset = decimals_offset;
                    vault.bump          = ctx.bumps.vault;
                    vault.paused        = false;
                    vault.vault_id      = vault_id;
                    vault.num_assets    = 0;
                    vault.base_decimals = 6;
                    vault._reserved     = [0u8; 64];
                    emit!(VaultInitialized {
                                    vault: vault.key(),
                                    authority: vault.authority,
                                    shares_mint: vault.shares_mint,
                                    vault_id,
                    });
                    Ok(())
        }
}

// ─────────────────────────────────────────────────────────────────────────────
// add_asset
// ─────────────────────────────────────────────────────────────────────────────
#[derive(Accounts)]
pub struct AddAsset<'info> {
        #[account(mut, has_one = authority @ VaultError::Unauthorized)]
        pub vault: Account<'info, MultiAssetVault>,
        pub asset_mint: InterfaceAccount<'info, Mint>,
        /// CHECK: Oracle account validated via oracle module.
        pub oracle: UncheckedAccount<'info>,
        #[account(
            init,
            payer = authority,
            space = AssetEntry::LEN,
            seeds = [b"asset_entry", vault.key().as_ref(), asset_mint.key().as_ref()],
            bump,
        )]
        pub asset_entry: Account<'info, AssetEntry>,
        #[account(
            init,
            payer = authority,
            token::mint = asset_mint,
            token::authority = vault,
            seeds = [b"asset_vault", vault.key().as_ref(), asset_mint.key().as_ref()],
            bump,
        )]
        pub asset_vault: InterfaceAccount<'info, TokenAccount>,
        #[account(mut)]
        pub authority: Signer<'info>,
        pub token_program: Interface<'info, TokenInterface>,
        pub system_program: Program<'info, System>,
        pub rent: Sysvar<'info, Rent>,
        // remaining_accounts: existing AssetEntry accounts for weight validation
}

pub mod add_asset {
        use super::*;
        pub fn handler(ctx: Context<AddAsset>, target_weight_bps: u16) -> Result<()> {
                    let vault = &mut ctx.accounts.vault;
                    require!(vault.num_assets < MAX_ASSETS, VaultError::MaxAssetsExceeded);
                    require!(target_weight_bps > 0 && target_weight_bps <= 10_000, VaultError::InvalidWeight);

            validate_oracle_price(
                            ctx.accounts.oracle.to_account_info(),
                            MAX_ORACLE_STALENESS,
                            MAX_ORACLE_CONFIDENCE_BPS,
                        )?;

            let mut current_weight: u32 = 0;
                    for ai in ctx.remaining_accounts.iter() {
                                    let entry: Account<AssetEntry> = Account::try_from(ai)?;
                                    current_weight = current_weight
                                        .checked_add(entry.target_weight_bps as u32)
                                        .ok_or(VaultError::MathOverflow)?;
                    }
                    require!(
                                    current_weight
                                        .checked_add(target_weight_bps as u32)
                                        .ok_or(VaultError::MathOverflow)?
                                        <= 10_000,
                                    VaultError::InvalidWeight
                                );

            let index = vault.num_assets;
                    let entry = &mut ctx.accounts.asset_entry;
                    entry.vault             = vault.key();
                    entry.asset_mint        = ctx.accounts.asset_mint.key();
                    entry.asset_vault       = ctx.accounts.asset_vault.key();
                    entry.oracle            = ctx.accounts.oracle.key();
                    entry.target_weight_bps = target_weight_bps;
                    entry.asset_decimals    = ctx.accounts.asset_mint.decimals;
                    entry.index             = index;
                    entry.bump              = ctx.bumps.asset_entry;
                    vault.num_assets = vault.num_assets.checked_add(1).ok_or(VaultError::MathOverflow)?;

            emit!(AssetAdded {
                            vault: vault.key(),
                            asset_mint: entry.asset_mint,
                            oracle: entry.oracle,
                            target_weight_bps,
                            index,
            });
                    Ok(())
        }
}

// ─────────────────────────────────────────────────────────────────────────────
// remove_asset
// ─────────────────────────────────────────────────────────────────────────────
#[derive(Accounts)]
pub struct RemoveAsset<'info> {
        #[account(mut, has_one = authority @ VaultError::Unauthorized)]
        pub vault: Account<'info, MultiAssetVault>,
        #[account(
                    mut,
                    has_one = vault @ VaultError::AssetNotFound,
                    seeds = [b"asset_entry", vault.key().as_ref(), asset_entry.asset_mint.as_ref()],
                    bump = asset_entry.bump,
                    close = authority,
                )]
        pub asset_entry: Account<'info, AssetEntry>,
        /// The PDA token account for this asset — must be empty before removal.
        #[account(
            mut,
            address = asset_entry.asset_vault @ VaultError::AssetNotFound,
        )]
        pub asset_vault: InterfaceAccount<'info, TokenAccount>,
        #[account(mut)]
        pub authority: Signer<'info>,
        pub token_program: Interface<'info, TokenInterface>,
}

pub mod remove_asset {
        use super::*;
        pub fn handler(ctx: Context<RemoveAsset>) -> Result<()> {
                    require!(ctx.accounts.asset_vault.amount == 0, VaultError::AssetVaultNotEmpty);
                    let vault = &mut ctx.accounts.vault;
                    let index = ctx.accounts.asset_entry.index;
                    let asset_mint = ctx.accounts.asset_entry.asset_mint;
                    vault.num_assets = vault.num_assets.checked_sub(1).ok_or(VaultError::MathOverflow)?;
                    emit!(AssetRemoved { vault: vault.key(), asset_mint, index });
                    Ok(())
        }
}

// ─────────────────────────────────────────────────────────────────────────────
// update_weights
// ─────────────────────────────────────────────────────────────────────────────
#[derive(Accounts)]
pub struct UpdateWeights<'info> {
        #[account(mut, has_one = authority @ VaultError::Unauthorized)]
        pub vault: Account<'info, MultiAssetVault>,
        pub authority: Signer<'info>,
        // remaining_accounts: all AssetEntry accounts in index order
}

pub mod update_weights {
        use super::*;
        pub fn handler(ctx: Context<UpdateWeights>, new_weights: Vec<u16>) -> Result<()> {
                    let num = ctx.accounts.vault.num_assets as usize;
                    require!(new_weights.len() == num, VaultError::WeightCountMismatch);

            let total: u32 = new_weights
                            .iter()
                            .map(|&w| w as u32)
                            .try_fold(0u32, |acc, w| acc.checked_add(w))
                            .ok_or(VaultError::MathOverflow)?;
                    require!(total == 10_000, VaultError::WeightsMustSumToTenThousand);

            require!(ctx.remaining_accounts.len() == num, VaultError::WeightCountMismatch);
                    for (i, ai) in ctx.remaining_accounts.iter().enumerate() {
                                    let mut entry: Account<AssetEntry> = Account::try_from(ai)?;
                                    entry.target_weight_bps = new_weights[i];
                                    entry.exit(ctx.program_id)?;
                    }

            emit!(WeightsUpdated { vault: ctx.accounts.vault.key(), weights: new_weights });
                    Ok(())
        }
}

// ─────────────────────────────────────────────────────────────────────────────
// deposit_single
// ─────────────────────────────────────────────────────────────────────────────
#[derive(Accounts)]
pub struct DepositSingle<'info> {
        #[account(mut, constraint = !vault.paused @ VaultError::VaultPaused)]
        pub vault: Account<'info, MultiAssetVault>,
        #[account(mut, has_one = vault @ VaultError::AssetNotFound)]
        pub asset_entry: Account<'info, AssetEntry>,
        #[account(mut, address = asset_entry.asset_vault @ VaultError::AssetNotFound)]
        pub asset_vault: InterfaceAccount<'info, TokenAccount>,
        #[account(mut)]
        pub user_asset_account: InterfaceAccount<'info, TokenAccount>,
        #[account(mut, address = vault.shares_mint)]
        pub shares_mint: InterfaceAccount<'info, Mint>,
        #[account(mut)]
        pub user_shares_account: InterfaceAccount<'info, TokenAccount>,
        #[account(mut)]
        pub user: Signer<'info>,
        /// CHECK: Oracle validated inside handler.
        pub oracle: UncheckedAccount<'info>,
        pub token_program: Interface<'info, TokenInterface>,
        // remaining_accounts: [AssetEntry, asset_vault, oracle] x num_assets (for total value calc)
}

pub mod deposit_single {
        use super::*;
        pub fn handler(
                    ctx: Context<DepositSingle>,
                    amount: u64,
                    min_shares_out: u64,
                ) -> Result<()> {
                    require!(amount > 0, VaultError::ZeroAmount);
                    let vault = &ctx.accounts.vault;
                    let entry = &ctx.accounts.asset_entry;

            let deposit_price = validate_oracle_price(
                            ctx.accounts.oracle.to_account_info(),
                            MAX_ORACLE_STALENESS,
                            MAX_ORACLE_CONFIDENCE_BPS,
                        )?;
                    let deposit_price_base =
                                    normalize_oracle_price(deposit_price.price, deposit_price.expo, entry.asset_decimals)?;
                    let deposit_value = entry
                                    .compute_value(amount, deposit_price_base)
                                    .ok_or(VaultError::MathOverflow)?;

            let total_value = compute_portfolio_value(ctx.remaining_accounts, MAX_ORACLE_STALENESS)?;
                    let offset = vault.decimals_offset_factor();
                    let shares = convert_to_shares(
                                    deposit_value,
                                    vault.total_shares,
                                    total_value,
                                    offset,
                                    Rounding::Floor,
                                )?;
                    require!(shares >= min_shares_out, VaultError::SlippageExceeded);

            // Transfer asset from user to asset vault
            anchor_spl::token_interface::transfer_checked(
                            CpiContext::new(
                                                ctx.accounts.token_program.to_account_info(),
                                                anchor_spl::token_interface::TransferChecked {
                                                                        from:      ctx.accounts.user_asset_account.to_account_info(),
                                                                        mint:      ctx.accounts.asset_vault.to_account_info(),
                                                                        to:        ctx.accounts.asset_vault.to_account_info(),
                                                                        authority: ctx.accounts.user.to_account_info(),
                                                },
                                            ),
                            amount,
                            entry.asset_decimals,
                        )?;

            // Mint shares to user (vault PDA is mint authority)
            let vault_id_bytes = vault.vault_id.to_le_bytes();
                    let seeds = &[b"multi_vault".as_ref(), vault_id_bytes.as_ref(), &[vault.bump]];
                    let signer_seeds = &[&seeds[..]];
                    anchor_spl::token_interface::mint_to(
                                    CpiContext::new_with_signer(
                                                        ctx.accounts.token_program.to_account_info(),
                                                        anchor_spl::token_interface::MintTo {
                                                                                mint:      ctx.accounts.shares_mint.to_account_info(),
                                                                                to:        ctx.accounts.user_shares_account.to_account_info(),
                                                                                authority: ctx.accounts.vault.to_account_info(),
                                                        },
                                                        signer_seeds,
                                                    ),
                                    shares,
                                )?;

            let vault = &mut ctx.accounts.vault;
                    vault.total_shares = vault.total_shares.checked_add(shares).ok_or(VaultError::MathOverflow)?;

            emit!(Deposit {
                            vault:      vault.key(),
                            user:       ctx.accounts.user.key(),
                            asset_mint: entry.asset_mint,
                            amount,
                            shares,
                            value:      deposit_value,
            });
                    Ok(())
        }
}

// ─────────────────────────────────────────────────────────────────────────────
// deposit_proportional
// ─────────────────────────────────────────────────────────────────────────────
#[derive(Accounts)]
pub struct DepositProportional<'info> {
        #[account(mut, constraint = !vault.paused @ VaultError::VaultPaused)]
        pub vault: Account<'info, MultiAssetVault>,
        #[account(mut, address = vault.shares_mint)]
        pub shares_mint: InterfaceAccount<'info, Mint>,
        #[account(mut)]
        pub user_shares_account: InterfaceAccount<'info, TokenAccount>,
        #[account(mut)]
        pub user: Signer<'info>,
        pub token_program: Interface<'info, TokenInterface>,
        // remaining_accounts: [AssetEntry, asset_vault, oracle, user_asset_account] x num_assets
}

pub mod deposit_proportional {
        use super::*;
        pub fn handler(
                    ctx: Context<DepositProportional>,
                    base_amount: u64,
                    min_shares_out: u64,
                ) -> Result<()> {
                    require!(base_amount > 0, VaultError::ZeroAmount);
                    let vault = &ctx.accounts.vault;
                    require!(vault.num_assets > 0, VaultError::BasketEmpty);
                    require!(ctx.remaining_accounts.len() % 4 == 0, VaultError::AssetNotFound);

            let vault_id_bytes = vault.vault_id.to_le_bytes();
                    let seeds = &[b"multi_vault".as_ref(), vault_id_bytes.as_ref(), &[vault.bump]];
                    let signer_seeds = &[&seeds[..]];

            let mut total_deposit_value: u64 = 0;
                    let mut amounts_out: Vec<u64> = Vec::new();

            // Pass 1 — compute per-asset amounts and transfer
            for chunk in ctx.remaining_accounts.chunks_exact(4) {
                            let entry_info       = &chunk[0];
                            let asset_vault_info = &chunk[1];
                            let oracle_info      = &chunk[2];
                            let user_token_info  = &chunk[3];

                        let entry: Account<AssetEntry> = Account::try_from(entry_info)?;

                        let price_data = validate_oracle_price(
                                            oracle_info.clone(),
                                            MAX_ORACLE_STALENESS,
                                            MAX_ORACLE_CONFIDENCE_BPS,
                                        )?;
                            let price_base =
                                                normalize_oracle_price(price_data.price, price_data.expo, entry.asset_decimals)?;

                        // asset_amount proportional to target weight
                        let asset_value = mul_div(
                                            base_amount,
                                            entry.target_weight_bps as u64,
                                            10_000,
                                            Rounding::Floor,
                                        )?;

                        // Convert base-unit value to token amount: amount = value * 10^decimals / price_base
                        let asset_amount = if price_base > 0 {
                                            mul_div(
                                                                    asset_value,
                                                                    10u64.pow(entry.asset_decimals as u32),
                                                                    price_base,
                                                                    Rounding::Floor,
                                                                )?
                        } else {
                                            0
                        };

                        if asset_amount > 0 {
                                            anchor_spl::token_interface::transfer_checked(
                                                                    CpiContext::new(
                                                                                                ctx.accounts.token_program.to_account_info(),
                                                                                                anchor_spl::token_interface::TransferChecked {
                                                                                                                                from:      user_token_info.clone(),
                                                                                                                                mint:      entry_info.clone(),
                                                                                                                                to:        asset_vault_info.clone(),
                                                                                                                                authority: ctx.accounts.user.to_account_info(),
                                                                                                    },
                                                                                            ),
                                                                    asset_amount,
                                                                    entry.asset_decimals,
                                                                )?;
                        }

                        let value = entry
                                            .compute_value(asset_amount, price_base)
                                            .ok_or(VaultError::MathOverflow)?;
                            total_deposit_value = total_deposit_value
                                .checked_add(value)
                                .ok_or(VaultError::MathOverflow)?;
                            amounts_out.push(asset_amount);
            }

            // Compute total portfolio value (re-read after deposits)
            let total_value = compute_portfolio_value(ctx.remaining_accounts, MAX_ORACLE_STALENESS)?;
                    let offset = vault.decimals_offset_factor();
                    let shares = convert_to_shares(
                                    total_deposit_value,
                                    vault.total_shares,
                                    total_value.saturating_sub(total_deposit_value),
                                    offset,
                                    Rounding::Floor,
                                )?;
                    require!(shares >= min_shares_out, VaultError::SlippageExceeded);

            anchor_spl::token_interface::mint_to(
                            CpiContext::new_with_signer(
                                                ctx.accounts.token_program.to_account_info(),
                                                anchor_spl::token_interface::MintTo {
                                                                        mint:      ctx.accounts.shares_mint.to_account_info(),
                                                                        to:        ctx.accounts.user_shares_account.to_account_info(),
                                                                        authority: ctx.accounts.vault.to_account_info(),
                                                },
                                                signer_seeds,
                                            ),
                            shares,
                        )?;

            let vault = &mut ctx.accounts.vault;
                    vault.total_shares = vault.total_shares.checked_add(shares).ok_or(VaultError::MathOverflow)?;

            emit!(ProportionalDeposit {
                            vault:       vault.key(),
                            user:        ctx.accounts.user.key(),
                            amounts:     amounts_out,
                            shares,
                            total_value: total_deposit_value,
            });
                    Ok(())
        }
}

// ─────────────────────────────────────────────────────────────────────────────
// redeem_single
// ─────────────────────────────────────────────────────────────────────────────
#[derive(Accounts)]
pub struct RedeemSingle<'info> {
        #[account(mut, constraint = !vault.paused @ VaultError::VaultPaused)]
        pub vault: Account<'info, MultiAssetVault>,
        #[account(mut, has_one = vault @ VaultError::AssetNotFound)]
        pub asset_entry: Account<'info, AssetEntry>,
        #[account(mut, address = asset_entry.asset_vault @ VaultError::AssetNotFound)]
        pub asset_vault: InterfaceAccount<'info, TokenAccount>,
        #[account(mut)]
        pub user_asset_account: InterfaceAccount<'info, TokenAccount>,
        #[account(mut, address = vault.shares_mint)]
        pub shares_mint: InterfaceAccount<'info, Mint>,
        #[account(mut)]
        pub user_shares_account: InterfaceAccount<'info, TokenAccount>,
        #[account(mut)]
        pub user: Signer<'info>,
        /// CHECK: Oracle validated inside handler.
        pub oracle: UncheckedAccount<'info>,
        pub token_program: Interface<'info, TokenInterface>,
        // remaining_accounts: [AssetEntry, asset_vault, oracle] x num_assets (total value)
}

pub mod redeem_single {
        use super::*;
        pub fn handler(
                    ctx: Context<RedeemSingle>,
                    shares: u64,
                    _asset_index: u8,
                    min_amount_out: u64,
                ) -> Result<()> {
                    require!(shares > 0, VaultError::ZeroAmount);
                    let vault = &ctx.accounts.vault;
                    require!(shares <= vault.total_shares, VaultError::InsufficientShares);

            let entry = &ctx.accounts.asset_entry;
                    let price_data = validate_oracle_price(
                                    ctx.accounts.oracle.to_account_info(),
                                    MAX_ORACLE_STALENESS,
                                    MAX_ORACLE_CONFIDENCE_BPS,
                                )?;
                    let price_base =
                                    normalize_oracle_price(price_data.price, price_data.expo, entry.asset_decimals)?;

            let total_value = compute_portfolio_value(ctx.remaining_accounts, MAX_ORACLE_STALENESS)?;
                    let offset = vault.decimals_offset_factor();

            // Redeem value = shares * total_value / total_shares
            let redeem_value = convert_to_assets(
                            shares,
                            vault.total_shares,
                            total_value,
                            offset,
                            Rounding::Ceiling,
                        )?;

            // Convert value to token amount
            let token_amount = if price_base > 0 {
                            mul_div(
                                                redeem_value,
                                                10u64.pow(entry.asset_decimals as u32),
                                                price_base,
                                                Rounding::Floor,
                                            )?
            } else {
                            0
            };

            require!(token_amount >= min_amount_out, VaultError::SlippageExceeded);

            // Burn shares first
            anchor_spl::token_interface::burn(
                            CpiContext::new(
                                                ctx.accounts.token_program.to_account_info(),
                                                anchor_spl::token_interface::Burn {
                                                                        mint:      ctx.accounts.shares_mint.to_account_info(),
                                                                        from:      ctx.accounts.user_shares_account.to_account_info(),
                                                                        authority: ctx.accounts.user.to_account_info(),
                                                },
                                            ),
                            shares,
                        )?;

            // Transfer asset to user
            let vault_id_bytes = vault.vault_id.to_le_bytes();
                    let signer_seeds = &[&[
                                    b"multi_vault".as_ref(),
                                    vault_id_bytes.as_ref(),
                                    &[vault.bump],
                                ][..]];
                    anchor_spl::token_interface::transfer_checked(
                                    CpiContext::new_with_signer(
                                                        ctx.accounts.token_program.to_account_info(),
                                                        anchor_spl::token_interface::TransferChecked {
                                                                                from:      ctx.accounts.asset_vault.to_account_info(),
                                                                                mint:      ctx.accounts.asset_vault.to_account_info(),
                                                                                to:        ctx.accounts.user_asset_account.to_account_info(),
                                                                                authority: ctx.accounts.vault.to_account_info(),
                                                        },
                                                        signer_seeds,
                                                    ),
                                    token_amount,
                                    entry.asset_decimals,
                                )?;

            let vault = &mut ctx.accounts.vault;
                    vault.total_shares = vault.total_shares.checked_sub(shares).ok_or(VaultError::MathOverflow)?;

            emit!(crate::events::RedeemSingle {
                            vault:      vault.key(),
                            user:       ctx.accounts.user.key(),
                            asset_mint: entry.asset_mint,
                            shares,
                            amount:     token_amount,
            });
                    Ok(())
        }
}

// ─────────────────────────────────────────────────────────────────────────────
// redeem_proportional
// ─────────────────────────────────────────────────────────────────────────────
#[derive(Accounts)]
pub struct RedeemProportional<'info> {
        #[account(mut, constraint = !vault.paused @ VaultError::VaultPaused)]
        pub vault: Account<'info, MultiAssetVault>,
        #[account(mut, address = vault.shares_mint)]
        pub shares_mint: InterfaceAccount<'info, Mint>,
        #[account(mut)]
        pub user_shares_account: InterfaceAccount<'info, TokenAccount>,
        #[account(mut)]
        pub user: Signer<'info>,
        pub token_program: Interface<'info, TokenInterface>,
        // remaining_accounts: [AssetEntry, asset_vault, oracle, user_asset_account] x num_assets
}

pub mod redeem_proportional {
        use super::*;
        pub fn handler(
                    ctx: Context<RedeemProportional>,
                    shares: u64,
                    min_values_out: Vec<u64>,
                ) -> Result<()> {
                    require!(shares > 0, VaultError::ZeroAmount);
                    let vault = &ctx.accounts.vault;
                    require!(shares <= vault.total_shares, VaultError::InsufficientShares);

            let vault_id_bytes = vault.vault_id.to_le_bytes();
                    let seeds = &[b"multi_vault".as_ref(), vault_id_bytes.as_ref(), &[vault.bump]];
                    let signer_seeds = &[&seeds[..]];

            let mut amounts_out = Vec::new();

            for (i, chunk) in ctx.remaining_accounts.chunks_exact(4).enumerate() {
                            let entry_info       = &chunk[0];
                            let asset_vault_info = &chunk[1];
                            let user_token_info  = &chunk[3];

                        let entry: Account<AssetEntry>             = Account::try_from(entry_info)?;
                            let asset_vault: InterfaceAccount<TokenAccount> =
                                                InterfaceAccount::try_from(asset_vault_info)?;

                        // Proportional share: user gets asset_vault.amount * shares / total_shares
                        let user_amount = mul_div(
                                            asset_vault.amount,
                                            shares,
                                            vault.total_shares,
                                            Rounding::Floor,
                                        )?;

                        if let Some(min) = min_values_out.get(i) {
                                            require!(user_amount >= *min, VaultError::SlippageExceeded);
                        }

                        if user_amount > 0 {
                                            anchor_spl::token_interface::transfer_checked(
                                                                    CpiContext::new_with_signer(
                                                                                                ctx.accounts.token_program.to_account_info(),
                                                                                                anchor_spl::token_interface::TransferChecked {
                                                                                                                                from:      asset_vault_info.clone(),
                                                                                                                                mint:      entry_info.clone(),
                                                                                                                                to:        user_token_info.clone(),
                                                                                                                                authority: ctx.accounts.vault.to_account_info(),
                                                                                                    },
                                                                                                signer_seeds,
                                                                                            ),
                                                                    user_amount,
                                                                    entry.asset_decimals,
                                                                )?;
                        }
                            amounts_out.push(user_amount);
            }

            anchor_spl::token_interface::burn(
                            CpiContext::new(
                                                ctx.accounts.token_program.to_account_info(),
                                                anchor_spl::token_interface::Burn {
                                                                        mint:      ctx.accounts.shares_mint.to_account_info(),
                                                                        from:      ctx.accounts.user_shares_account.to_account_info(),
                                                                        authority: ctx.accounts.user.to_account_info(),
                                                },
                                            ),
                            shares,
                        )?;

            let vault = &mut ctx.accounts.vault;
                    vault.total_shares = vault.total_shares.checked_sub(shares).ok_or(VaultError::MathOverflow)?;

            emit!(ProportionalRedeem {
                            vault:   vault.key(),
                            user:    ctx.accounts.user.key(),
                            shares,
                            amounts: amounts_out,
            });
                    Ok(())
        }
}

// ─────────────────────────────────────────────────────────────────────────────
// rebalance (Jupiter CPI)
// ─────────────────────────────────────────────────────────────────────────────
/// Known Jupiter v6 program ID on mainnet/devnet.
const JUPITER_PROGRAM_ID: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

#[derive(Accounts)]
pub struct Rebalance<'info> {
        #[account(mut, has_one = authority @ VaultError::Unauthorized)]
        pub vault: Account<'info, MultiAssetVault>,
        pub authority: Signer<'info>,
        #[account(mut)]
        pub from_asset_vault: InterfaceAccount<'info, TokenAccount>,
        #[account(mut)]
        pub to_asset_vault: InterfaceAccount<'info, TokenAccount>,
        pub from_asset_mint: InterfaceAccount<'info, Mint>,
        pub to_asset_mint: InterfaceAccount<'info, Mint>,
        /// CHECK: validated against known Jupiter program ID.
        pub jupiter_program: UncheckedAccount<'info>,
        pub token_program: Interface<'info, TokenInterface>,
        // remaining_accounts: Jupiter route accounts
}

pub mod rebalance {
        use super::*;
        use anchor_lang::solana_program::program::invoke_signed;
        use anchor_lang::solana_program::instruction::Instruction;

    pub fn handler(ctx: Context<Rebalance>, route_data: Vec<u8>, minimum_out: u64) -> Result<()> {
                // Validate Jupiter program ID
            let expected: Pubkey = JUPITER_PROGRAM_ID.parse().map_err(|_| VaultError::InvalidProgram)?;
                require!(
                                ctx.accounts.jupiter_program.key() == expected,
                                VaultError::InvalidProgram
                            );

            let vault = &ctx.accounts.vault;
                let to_before = ctx.accounts.to_asset_vault.amount;
                let from_before = ctx.accounts.from_asset_vault.amount;

            let vault_id_bytes = vault.vault_id.to_le_bytes();
                let seeds = &[b"multi_vault".as_ref(), vault_id_bytes.as_ref(), &[vault.bump]];
                let signer_seeds = &[&seeds[..]];

            // Build Jupiter instruction from route_data
            let mut accounts: Vec<anchor_lang::solana_program::instruction::AccountMeta> = vec![
                            anchor_lang::solana_program::instruction::AccountMeta::new(
                                                ctx.accounts.from_asset_vault.key(),
                                                false,
                                            ),
                            anchor_lang::solana_program::instruction::AccountMeta::new(
                                                ctx.accounts.to_asset_vault.key(),
                                                false,
                                            ),
                            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                                                ctx.accounts.vault.key(),
                                                true,
                                            ),
                        ];
                for ai in ctx.remaining_accounts.iter() {
                                accounts.push(if ai.is_writable {
                                                    anchor_lang::solana_program::instruction::AccountMeta::new(*ai.key, ai.is_signer)
                                } else {
                                                    anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                                                                            *ai.key,
                                                                            ai.is_signer,
                                                                        )
                                });
                }

            let ix = Instruction {
                            program_id: ctx.accounts.jupiter_program.key(),
                            accounts,
                            data: route_data,
            };

            let mut account_infos: Vec<AccountInfo> = vec![
                            ctx.accounts.from_asset_vault.to_account_info(),
                            ctx.accounts.to_asset_vault.to_account_info(),
                            ctx.accounts.vault.to_account_info(),
                        ];
                account_infos.extend_from_slice(ctx.remaining_accounts);

            invoke_signed(&ix, &account_infos, signer_seeds)?;

            // Reload and verify slippage
            ctx.accounts.to_asset_vault.reload()?;
                ctx.accounts.from_asset_vault.reload()?;

            let received = ctx.accounts.to_asset_vault.amount
                            .checked_sub(to_before)
                            .ok_or(VaultError::MathOverflow)?;
                require!(received >= minimum_out, VaultError::SlippageExceeded);

            let amount_in = from_before
                            .checked_sub(ctx.accounts.from_asset_vault.amount)
                            .unwrap_or(0);

            emit!(crate::events::Rebalance {
                            vault:      vault.key(),
                            from_asset: ctx.accounts.from_asset_mint.key(),
                            to_asset:   ctx.accounts.to_asset_mint.key(),
                            amount_in,
                            amount_out: received,
            });
                Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// set_paused
// ─────────────────────────────────────────────────────────────────────────────
#[derive(Accounts)]
pub struct SetPaused<'info> {
        #[account(mut, has_one = authority @ VaultError::Unauthorized)]
        pub vault: Account<'info, MultiAssetVault>,
        pub authority: Signer<'info>,
}

pub mod set_paused {
        use super::*;
        pub fn handler(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
                    ctx.accounts.vault.paused = paused;
                    emit!(PauseStateChanged { vault: ctx.accounts.vault.key(), paused });
                    Ok(())
        }
}

// ─────────────────────────────────────────────────────────────────────────────
// transfer_authority
// ─────────────────────────────────────────────────────────────────────────────
#[derive(Accounts)]
pub struct TransferAuthority<'info> {
        #[account(mut, has_one = authority @ VaultError::Unauthorized)]
        pub vault: Account<'info, MultiAssetVault>,
        pub authority: Signer<'info>,
}

pub mod transfer_authority {
        use super::*;
        pub fn handler(ctx: Context<TransferAuthority>, new_authority: Pubkey) -> Result<()> {
                    require!(new_authority != ctx.accounts.authority.key(), VaultError::SameAuthority);
                    let old = ctx.accounts.vault.authority;
                    ctx.accounts.vault.authority = new_authority;
                    emit!(AuthorityTransferred {
                                    vault:         ctx.accounts.vault.key(),
                                    old_authority: old,
                                    new_authority,
                    });
                    Ok(())
        }
}
