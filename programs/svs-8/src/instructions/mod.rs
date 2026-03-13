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
        vault.authority = ctx.accounts.authority.key();
        vault.shares_mint = ctx.accounts.shares_mint.key();
        vault.total_shares = 0;
        vault.decimals_offset = decimals_offset;
        vault.bump = ctx.bumps.vault;
        vault.paused = false;
        vault.vault_id = vault_id;
        vault.num_assets = 0;
        vault.base_decimals = 6; // USD base
        vault._reserved = [0u8; 64];

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

        // Validate oracle freshness
        validate_oracle_price(
            ctx.accounts.oracle.to_account_info(),
            MAX_ORACLE_STALENESS,
            MAX_ORACLE_CONFIDENCE_BPS,
        )?;

        // Check existing weight sum won't overflow 10_000
        let mut current_weight: u32 = 0;
        for ai in ctx.remaining_accounts.iter() {
            let entry: Account<AssetEntry> = Account::try_from(ai)?;
            current_weight = current_weight.checked_add(entry.target_weight_bps as u32)
                .ok_or(VaultError::MathOverflow)?;
        }
        require!(
            current_weight.checked_add(target_weight_bps as u32).ok_or(VaultError::MathOverflow)? <= 10_000,
            VaultError::InvalidWeight
        );

        let index = vault.num_assets;
        let entry = &mut ctx.accounts.asset_entry;
        entry.vault = vault.key();
        entry.asset_mint = ctx.accounts.asset_mint.key();
        entry.asset_vault = ctx.accounts.asset_vault.key();
        entry.oracle = ctx.accounts.oracle.key();
        entry.target_weight_bps = target_weight_bps;
        entry.asset_decimals = ctx.accounts.asset_mint.decimals;
        entry.index = index;
        entry.bump = ctx.bumps.asset_entry;

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
// deposit_single  
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct DepositSingle<'info> {
    #[account(mut, constraint = !vault.paused @ VaultError::VaultPaused)]
    pub vault: Account<'info, MultiAssetVault>,

    #[account(mut)]
    pub asset_entry: Account<'info, AssetEntry>,

    #[account(mut)]
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

        // Validate this asset's oracle
        let deposit_price = validate_oracle_price(
            ctx.accounts.oracle.to_account_info(),
            MAX_ORACLE_STALENESS,
            MAX_ORACLE_CONFIDENCE_BPS,
        )?;

        // Value of deposited amount in base units
        let deposit_price_base = normalize_oracle_price(deposit_price.price, deposit_price.expo, entry.asset_decimals)?;
        let deposit_value = entry.compute_value(amount, deposit_price_base)
            .ok_or(VaultError::MathOverflow)?;

        // Compute total portfolio value from remaining_accounts [AssetEntry, asset_vault, oracle] x N
        let total_value = compute_portfolio_value(ctx.remaining_accounts, MAX_ORACLE_STALENESS)?;

        // Convert deposit value to shares
        let offset = vault.decimals_offset_factor();
        let shares = convert_to_shares(
            deposit_value,
            vault.total_shares,
            total_value,
            offset,
            Rounding::Floor,
        )?;

        require!(shares >= min_shares_out, VaultError::SlippageExceeded);

        // Transfer asset from user to asset_vault
        anchor_spl::token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token_interface::TransferChecked {
                    from: ctx.accounts.user_asset_account.to_account_info(),
                    mint: ctx.accounts.asset_vault.to_account_info(),
                    to: ctx.accounts.asset_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
            entry.asset_decimals,
        )?;

        // Mint shares to user
        let vault_id_bytes = vault.vault_id.to_le_bytes();
        let seeds = &[b"multi_vault".as_ref(), vault_id_bytes.as_ref(), &[vault.bump]];
        let signer_seeds = &[&seeds[..]];

        anchor_spl::token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token_interface::MintTo {
                    mint: ctx.accounts.shares_mint.to_account_info(),
                    to: ctx.accounts.user_shares_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            ),
            shares,
        )?;

        let vault = &mut ctx.accounts.vault;
        vault.total_shares = vault.total_shares.checked_add(shares).ok_or(VaultError::MathOverflow)?;

        emit!(Deposit {
            vault: vault.key(),
            user: ctx.accounts.user.key(),
            asset_mint: entry.asset_mint,
            amount,
            shares,
            value: deposit_value,
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

        // Compute portfolio value and per-asset proportional amounts
        let total_value = compute_portfolio_value(ctx.remaining_accounts, MAX_ORACLE_STALENESS)?;
        let offset = vault.decimals_offset_factor();
        let redeem_value = convert_to_assets(shares, vault.total_shares, total_value, offset, Rounding::Ceiling)?;
        let _ = redeem_value;

        let vault_id_bytes = vault.vault_id.to_le_bytes();
        let seeds = &[b"multi_vault".as_ref(), vault_id_bytes.as_ref(), &[vault.bump]];
        let signer_seeds = &[&seeds[..]];

        // remaining_accounts in groups of 4: [AssetEntry, asset_vault, oracle, user_asset_account]
        let chunks = ctx.remaining_accounts.chunks_exact(4);
        let mut amounts_out = Vec::new();
        for (i, chunk) in chunks.enumerate() {
            let entry_info = &chunk[0];
            let asset_vault_info = &chunk[1];
            let user_token_info = &chunk[3];

            let entry: Account<AssetEntry> = Account::try_from(entry_info)?;
            let asset_vault: InterfaceAccount<TokenAccount> = InterfaceAccount::try_from(asset_vault_info)?;

            // User gets proportional share: asset_vault.amount * shares / total_shares
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
                // Transfer asset from vault to user
                anchor_spl::token_interface::transfer_checked(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        anchor_spl::token_interface::TransferChecked {
                            from: asset_vault_info.clone(),
                            mint: entry_info.clone(),
                            to: user_token_info.clone(),
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
                    mint: ctx.accounts.shares_mint.to_account_info(),
                    from: ctx.accounts.user_shares_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            shares,
        )?;

        let vault = &mut ctx.accounts.vault;
        vault.total_shares = vault.total_shares.checked_sub(shares).ok_or(VaultError::MathOverflow)?;

        emit!(ProportionalRedeem {
            vault: vault.key(),
            user: ctx.accounts.user.key(),
            shares,
            amounts: amounts_out,
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
            vault: ctx.accounts.vault.key(),
            old_authority: old,
            new_authority,
        });
        Ok(())
    }
}

// Stubs for remaining instructions (full implementations in individual files)
pub mod remove_asset { use super::*; pub fn handler(_ctx: Context<RemoveAsset>) -> Result<()> { Ok(()) } }
pub mod update_weights { use super::*; pub fn handler(_ctx: Context<UpdateWeights>, _w: Vec<u16>) -> Result<()> { Ok(()) } }
pub mod deposit_proportional { use super::*; pub fn handler(_ctx: Context<DepositProportional>, _a: u64, _m: u64) -> Result<()> { Ok(()) } }
pub mod redeem_single { use super::*; pub fn handler(_ctx: Context<RedeemSingle>, _s: u64, _i: u8, _m: u64) -> Result<()> { Ok(()) } }
pub mod rebalance { use super::*; pub fn handler(_ctx: Context<Rebalance>, _r: Vec<u8>, _m: u64) -> Result<()> { Ok(()) } }

// Placeholder account structs for stubs
#[derive(Accounts)] pub struct RemoveAsset<'info> { #[account(mut)] pub vault: Account<'info, MultiAssetVault>, pub authority: Signer<'info> }
#[derive(Accounts)] pub struct UpdateWeights<'info> { #[account(mut)] pub vault: Account<'info, MultiAssetVault>, pub authority: Signer<'info> }
#[derive(Accounts)] pub struct DepositProportional<'info> { #[account(mut)] pub vault: Account<'info, MultiAssetVault>, pub authority: Signer<'info> }
#[derive(Accounts)] pub struct RedeemSingle<'info> { #[account(mut)] pub vault: Account<'info, MultiAssetVault>, pub authority: Signer<'info> }
#[derive(Accounts)] pub struct Rebalance<'info> { #[account(mut)] pub vault: Account<'info, MultiAssetVault>, pub authority: Signer<'info> }
