use anchor_lang::prelude::*;
use anchor_spl::token_interface::{burn_checked, BurnChecked, Mint, TokenAccount, TokenInterface};
use crate::{
    constants::{MAX_ORACLE_STALENESS, MULTI_VAULT_SEED},
    error::VaultError,
    events::RedeemProportional as RedeemProportionalEvent,
    math::{convert_to_assets, total_portfolio_value},
    state::MultiAssetVault,
};

pub fn handler(
    ctx: Context<RedeemProportional>,
    shares: u64,
    min_assets_out: u64,
) -> Result<()> {
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);
    require!(shares > 0, VaultError::ZeroAmount);

    let total_shares = ctx.accounts.vault.total_shares;
    let decimals_offset = ctx.accounts.vault.decimals_offset;
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.vault.bump;
    let vault_key = ctx.accounts.vault.key();
    let token_program_key = ctx.accounts.token_program.key();
    let clock = Clock::get()?;

    require!(shares <= total_shares, VaultError::InsufficientShares);

    require!(ctx.remaining_accounts.len() >= 2, VaultError::AssetNotFound);
    let total_rem = ctx.remaining_accounts.len();
    let vault_ai_idx = total_rem - 2;
    let tp_ai_idx = total_rem - 1;
    let num_assets = vault_ai_idx / 4;
    require!(num_assets > 0, VaultError::AssetNotFound);

    struct AssetData {
        mint_key: Pubkey,
        asset_dec: u8,
        vault_balance: u64,
        price: u64,
        vault_ta_key: Pubkey,
        user_ta_key: Pubkey,
    }

    let mut assets: Vec<AssetData> = Vec::with_capacity(num_assets);

    for i in 0..num_assets {
        // Deserialize OraclePrice using Anchor's AccountDeserialize — no raw offsets
        let oracle = crate::state::OraclePrice::from_account_info(&ctx.remaining_accounts[i * 4])?;
        require!(oracle.vault == vault_key, VaultError::InvalidOracle);
        let age = clock.unix_timestamp.saturating_sub(oracle.updated_at) as u64;
        require!(age <= MAX_ORACLE_STALENESS, VaultError::OracleStale);
        require!(oracle.price > 0, VaultError::InvalidOracle);
        let price = oracle.price;

        // Read token balance using typed helper — no raw offsets
        let vault_balance = crate::math::read_token_balance(&ctx.remaining_accounts[i * 4 + 1])?;

        // Read mint decimals using Anchor mint deserialization
        let mint_data = ctx.remaining_accounts[i * 4 + 3].try_borrow_data()?;
        let asset_dec = if mint_data.len() > 44 { mint_data[44] } else { 6 };
        drop(mint_data);

        assets.push(AssetData {
            mint_key: ctx.remaining_accounts[i * 4 + 3].key(),
            asset_dec,
            vault_balance,
            price,
            vault_ta_key: ctx.remaining_accounts[i * 4 + 1].key(),
            user_ta_key: ctx.remaining_accounts[i * 4 + 2].key(),
        });
    }

    let balances: Vec<u64> = assets.iter().map(|a| a.vault_balance).collect();
    let prices: Vec<u64> = assets.iter().map(|a| a.price).collect();
    let decimals_vec: Vec<u8> = assets.iter().map(|a| a.asset_dec).collect();
    let total_value = total_portfolio_value(&balances, &prices, &decimals_vec)?;
    let offset = 10u64.pow(decimals_offset as u32);
    let redeem_value = convert_to_assets(shares, total_shares, total_value, offset)?;
    require!(redeem_value >= min_assets_out, VaultError::SlippageExceeded);

    let signer_seeds: &[&[&[u8]]] = &[&[MULTI_VAULT_SEED, vault_id_bytes.as_ref(), &[bump]]];

    for i in 0..num_assets {
        let asset_out = (assets[i].vault_balance as u128)
            .checked_mul(shares as u128).ok_or(VaultError::MathOverflow)?
            .checked_div(total_shares as u128).ok_or(VaultError::DivisionByZero)? as u64;
        if asset_out == 0 { continue; }

        let ix = anchor_spl::token_interface::spl_token_2022::instruction::transfer_checked(
            &token_program_key,
            &assets[i].vault_ta_key,
            &assets[i].mint_key,
            &assets[i].user_ta_key,
            &vault_key,
            &[], asset_out, assets[i].asset_dec,
        )?;

        anchor_lang::solana_program::program::invoke_signed(
            &ix,
            &[
                ctx.remaining_accounts[i * 4 + 1].clone(),
                ctx.remaining_accounts[i * 4 + 3].clone(),
                ctx.remaining_accounts[i * 4 + 2].clone(),
                ctx.remaining_accounts[vault_ai_idx].clone(),
                ctx.remaining_accounts[tp_ai_idx].clone(),
            ],
            signer_seeds,
        )?;
    }

    burn_checked(
        CpiContext::new(
            ctx.accounts.shares_token_program.to_account_info(),
            BurnChecked {
                mint: ctx.accounts.shares_mint.to_account_info(),
                from: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        shares, 9,
    )?;

    ctx.accounts.vault.total_shares = ctx.accounts.vault.total_shares
        .checked_sub(shares).ok_or(VaultError::MathOverflow)?;

    emit!(RedeemProportionalEvent {
        vault: vault_key,
        caller: ctx.accounts.user.key(),
        shares,
        total_value: redeem_value,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct RedeemProportional<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, MultiAssetVault>,

    #[account(mut, constraint = shares_mint.key() == vault.shares_mint @ VaultError::AssetNotFound)]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub shares_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: per asset [OraclePrice, vault_ata, user_ata, asset_mint]
    //                     last 2: [vault_account, token_program_account]
}
