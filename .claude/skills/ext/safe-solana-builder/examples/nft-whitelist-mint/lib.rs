// ============================================================
// Program: NFT Whitelist Mint
// Framework: Anchor
// Author: Frank Castle Security Template
// Security: See accompanying security-checklist.md
//
// Architecture:
//   MintConfig PDA  — global program config (authority, price, supply)
//   WhitelistEntry  — per-user PDA; exists = whitelisted, has_minted = double-mint guard
//
// Instructions:
//   initialize           — admin: create MintConfig
//   add_to_whitelist     — admin: create WhitelistEntry for a user
//   remove_from_whitelist— admin: close WhitelistEntry (de-whitelist)
//   mint_nft             — whitelisted user: mint one NFT
// ============================================================

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{self, Mint, MintTo, TokenAccount, TokenInterface},
};
use mpl_token_metadata::{
    instruction::{create_master_edition_v3, create_metadata_accounts_v3},
    state::DataV2,
    ID as TOKEN_METADATA_PROGRAM_ID,
};

declare_id!("REPLACE_WITH_YOUR_PROGRAM_ID");

// ─────────────────────────────────────────────────────────────
// PROGRAM
// ─────────────────────────────────────────────────────────────

#[program]
pub mod nft_whitelist_mint {
    use super::*;

    /// Initialize the mint config. Can only be called once — `init` enforces this.
    /// Authority is the signer at init time. Transfer authority after deployment if needed.
    pub fn initialize(
        ctx: Context<Initialize>,
        price: u64,
        max_supply: u32,
    ) -> Result<()> {
        // Validate inputs before touching state
        require!(price > 0, MintError::InvalidPrice);
        require!(max_supply > 0, MintError::InvalidMaxSupply);

        let config = &mut ctx.accounts.mint_config;
        config.authority = ctx.accounts.authority.key();
        config.price = price;
        config.max_supply = max_supply;
        config.current_supply = 0;
        // SECURITY: Store canonical bump — never re-derive with find_program_address on subsequent calls
        config.bump = ctx.bumps.mint_config;

        emit!(ConfigInitialized {
            authority: config.authority,
            price,
            max_supply,
        });

        Ok(())
    }

    /// Admin adds a user to the whitelist by creating their WhitelistEntry PDA.
    /// Idempotent at the account level — `init` will reject if the entry already exists.
    pub fn add_to_whitelist(ctx: Context<AddToWhitelist>) -> Result<()> {
        let entry = &mut ctx.accounts.whitelist_entry;
        entry.user = ctx.accounts.user.key();
        entry.has_minted = false;
        // SECURITY: Store canonical bump for this user-specific PDA
        entry.bump = ctx.bumps.whitelist_entry;

        emit!(UserWhitelisted {
            user: entry.user,
        });

        Ok(())
    }

    /// Admin removes a user from the whitelist by closing their WhitelistEntry PDA.
    /// Lamports return to authority. `close` constraint: zeroes data, transfers lamports,
    /// reassigns owner to System Program — preventing account revival.
    pub fn remove_from_whitelist(_ctx: Context<RemoveFromWhitelist>) -> Result<()> {
        // SECURITY: The `close = authority` constraint in the accounts struct handles
        // the full safe close sequence (zero data → transfer lamports → assign to system program).
        // No manual lamport manipulation needed or allowed here.
        Ok(())
    }

    /// Whitelisted user mints one NFT.
    /// Transfers payment in SOL, creates the SPL mint (0 decimals), mints 1 token,
    /// creates Metaplex metadata and master edition.
    pub fn mint_nft(
        ctx: Context<MintNft>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        // ── Input validation ──────────────────────────────────────
        require!(!name.is_empty(), MintError::EmptyMetadataField);
        require!(!symbol.is_empty(), MintError::EmptyMetadataField);
        require!(!uri.is_empty(), MintError::EmptyMetadataField);
        require!(name.len() <= 32, MintError::MetadataFieldTooLong);
        require!(symbol.len() <= 10, MintError::MetadataFieldTooLong);
        require!(uri.len() <= 200, MintError::MetadataFieldTooLong);

        let config = &ctx.accounts.mint_config;
        let entry = &mut ctx.accounts.whitelist_entry;

        // ── Double-mint guard ─────────────────────────────────────
        // SECURITY: Even if the whitelist entry exists, block re-mint.
        require!(!entry.has_minted, MintError::AlreadyMinted);

        // ── Supply check ──────────────────────────────────────────
        require!(
            config.current_supply < config.max_supply,
            MintError::MaxSupplyReached
        );

        // ── SOL payment ───────────────────────────────────────────
        // SECURITY: Record payer balance before CPI to detect unexpected SOL drain.
        let payer_balance_before = ctx.accounts.payer.lamports();

        // Transfer mint price from payer to authority treasury
        // SECURITY: Using system_program CPI — program ID validated via Program<'info, System>
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.authority.to_account_info(),
                },
            ),
            config.price,
        )?;

        // SECURITY: Verify SOL was spent as expected — no more than price was taken
        let payer_balance_after = ctx.accounts.payer.lamports();
        require!(
            payer_balance_before
                .checked_sub(payer_balance_after)
                .ok_or(MintError::ArithmeticOverflow)?
                <= config.price.checked_add(10_000).ok_or(MintError::ArithmeticOverflow)?,
            MintError::ExcessiveSolSpend
        );

        // ── Mint 1 token to user's ATA ────────────────────────────
        // SECURITY: MintConfig PDA signs the mint_to CPI using stored canonical bump
        let config_seeds = &[
            b"mint_config".as_ref(),
            &[config.bump],
        ];
        let signer_seeds = &[&config_seeds[..]];

        // SECURITY: Using token_interface::mint_to — compatible with Token-2022 if needed
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.nft_mint.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.mint_config.to_account_info(),
                },
                signer_seeds,
            ),
            1, // Exactly 1 — NFT
        )?;

        // ── Metaplex: Create metadata account ─────────────────────
        // SECURITY: TOKEN_METADATA_PROGRAM_ID is a hardcoded constant — not user-supplied.
        // Checked via require_keys_eq! before use in CPI.
        require_keys_eq!(
            ctx.accounts.token_metadata_program.key(),
            TOKEN_METADATA_PROGRAM_ID,
            MintError::InvalidMetadataProgram
        );

        let create_metadata_ix = create_metadata_accounts_v3(
            TOKEN_METADATA_PROGRAM_ID,
            ctx.accounts.metadata.key(),
            ctx.accounts.nft_mint.key(),
            ctx.accounts.mint_config.key(), // mint authority = MintConfig PDA
            ctx.accounts.payer.key(),
            ctx.accounts.mint_config.key(), // update authority = MintConfig PDA
            name.clone(),
            symbol.clone(),
            uri.clone(),
            None,  // creators — extend here for royalties
            0,     // seller_fee_basis_points
            true,  // update_authority_is_signer
            true,  // is_mutable — set false after reveal if applicable
            None,  // collection
            None,  // uses
            None,  // collection_details
        );

        anchor_lang::solana_program::program::invoke_signed(
            &create_metadata_ix,
            &[
                ctx.accounts.metadata.to_account_info(),
                ctx.accounts.nft_mint.to_account_info(),
                ctx.accounts.mint_config.to_account_info(), // mint authority
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.mint_config.to_account_info(), // update authority
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.rent.to_account_info(),
            ],
            &[config_seeds],
        )?;

        // ── Metaplex: Create master edition ───────────────────────
        // Max supply = 0 enforces true 1-of-1 NFT (no prints).
        let create_edition_ix = create_master_edition_v3(
            TOKEN_METADATA_PROGRAM_ID,
            ctx.accounts.master_edition.key(),
            ctx.accounts.nft_mint.key(),
            ctx.accounts.mint_config.key(), // update authority
            ctx.accounts.mint_config.key(), // mint authority
            ctx.accounts.metadata.key(),
            ctx.accounts.payer.key(),
            Some(0), // max_supply = 0 → no prints possible
        );

        anchor_lang::solana_program::program::invoke_signed(
            &create_edition_ix,
            &[
                ctx.accounts.master_edition.to_account_info(),
                ctx.accounts.nft_mint.to_account_info(),
                ctx.accounts.mint_config.to_account_info(), // update authority
                ctx.accounts.mint_config.to_account_info(), // mint authority
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.metadata.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.rent.to_account_info(),
            ],
            &[config_seeds],
        )?;

        // ── Update state AFTER all CPIs succeed ───────────────────
        // SECURITY: Reload config before mutating — CPI may have altered state
        ctx.accounts.mint_config.reload()?;

        let config = &mut ctx.accounts.mint_config;

        // SECURITY: Checked arithmetic — supply increment cannot overflow
        config.current_supply = config
            .current_supply
            .checked_add(1)
            .ok_or(MintError::ArithmeticOverflow)?;

        // SECURITY: Mark entry as minted — prevents double-mint even if authority
        // forgets to remove the whitelist entry
        entry.has_minted = true;

        emit!(NftMinted {
            user: ctx.accounts.payer.key(),
            mint: ctx.accounts.nft_mint.key(),
            supply_after: config.current_supply,
        });

        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────
// ACCOUNT STRUCTS
// ─────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = MintConfig::LEN,
        // SECURITY: Unique seed prefix "mint_config" isolates this PDA from any other.
        // No user pubkey needed — this is a global singleton config.
        seeds = [b"mint_config"],
        bump,
    )]
    pub mint_config: Account<'info, MintConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction()]
pub struct AddToWhitelist<'info> {
    #[account(
        mut,
        seeds = [b"mint_config"],
        bump = mint_config.bump,
        // SECURITY: Enforces that the signer IS the stored authority — not just any signer
        has_one = authority @ MintError::UnauthorizedAuthority,
    )]
    pub mint_config: Account<'info, MintConfig>,

    #[account(
        init,
        payer = authority,
        space = WhitelistEntry::LEN,
        // SECURITY: User pubkey in seeds — each entry is user-specific, no PDA sharing
        seeds = [b"whitelist", user.key().as_ref()],
        bump,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,

    /// The wallet being whitelisted. Does not need to sign — admin action.
    /// CHECK: This is the user pubkey used as a seed for their whitelist PDA.
    /// We don't read or write this account's data — only use its key as a seed.
    pub user: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveFromWhitelist<'info> {
    #[account(
        seeds = [b"mint_config"],
        bump = mint_config.bump,
        has_one = authority @ MintError::UnauthorizedAuthority,
    )]
    pub mint_config: Account<'info, MintConfig>,

    #[account(
        mut,
        // SECURITY: `close` constraint: zeroes data, transfers lamports, assigns to system program.
        // Prevents account revival. Returns rent to authority (trusted destination).
        close = authority,
        seeds = [b"whitelist", whitelist_entry.user.as_ref()],
        bump = whitelist_entry.bump,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintNft<'info> {
    #[account(
        mut,
        seeds = [b"mint_config"],
        bump = mint_config.bump,
    )]
    pub mint_config: Account<'info, MintConfig>,

    #[account(
        mut,
        // SECURITY: Verify this entry belongs to the payer — not someone else's entry
        seeds = [b"whitelist", payer.key().as_ref()],
        bump = whitelist_entry.bump,
        constraint = whitelist_entry.user == payer.key() @ MintError::WhitelistMismatch,
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,

    /// The NFT mint account. Must be a fresh keypair — 0 decimals enforced in constraint.
    #[account(
        init,
        payer = payer,
        mint::decimals = 0,          // NFT: 0 decimals
        mint::authority = mint_config, // MintConfig PDA is mint authority
        mint::freeze_authority = mint_config,
        // SECURITY: Verify payer and nft_mint are not the same account
        constraint = payer.key() != nft_mint.key() @ MintError::DuplicateAccount,
    )]
    pub nft_mint: Box<InterfaceAccount<'info, Mint>>,

    /// User's ATA for this mint — created here if it doesn't exist.
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = nft_mint,
        associated_token::authority = payer,
        // SECURITY: init_if_needed used here because ATA creation is idempotent by design.
        // We do NOT use init_if_needed on any program state account.
        // The double-mint guard (has_minted flag) provides the security invariant, not this constraint.
    )]
    pub user_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Metaplex metadata account — PDA derived by Metaplex program.
    /// CHECK: This account is created and validated by the Metaplex Token Metadata program.
    /// We pass it through to the CPI. Its derivation is verified inside the Metaplex program.
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,

    /// Metaplex master edition account.
    /// CHECK: Created and validated by the Metaplex Token Metadata program via CPI.
    #[account(mut)]
    pub master_edition: UncheckedAccount<'info>,

    /// The stored authority pubkey — receives SOL payment.
    /// SECURITY: We read authority from mint_config (trusted storage), not from user input.
    /// CHECK: Authority pubkey is validated via `mint_config.authority` — trusted stored value.
    #[account(
        mut,
        constraint = authority.key() == mint_config.authority @ MintError::UnauthorizedAuthority,
    )]
    pub authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// SECURITY: Program<'info, T> validates executable + program ID automatically.
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    pub rent: Sysvar<'info, Rent>,

    /// SECURITY: Verified via require_keys_eq! against TOKEN_METADATA_PROGRAM_ID constant
    /// before any CPI call. Never accepted as a trusted program without this check.
    /// CHECK: Verified via require_keys_eq! against hardcoded TOKEN_METADATA_PROGRAM_ID.
    pub token_metadata_program: UncheckedAccount<'info>,
}

// ─────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────

#[account]
pub struct MintConfig {
    /// The admin authority. Only this pubkey can add/remove whitelist entries and update config.
    pub authority: Pubkey,      // 32
    /// Price in lamports per NFT mint.
    pub price: u64,             // 8
    /// Maximum number of NFTs that can be minted.
    pub max_supply: u32,        // 4
    /// Number of NFTs minted so far.
    pub current_supply: u32,    // 4
    /// Canonical bump for this PDA — stored at init, reused on all subsequent calls.
    pub bump: u8,               // 1
}

impl MintConfig {
    // discriminator(8) + authority(32) + price(8) + max_supply(4) + current_supply(4) + bump(1)
    pub const LEN: usize = 8 + 32 + 8 + 4 + 4 + 1;
}

#[account]
pub struct WhitelistEntry {
    /// The whitelisted user's pubkey. Redundant with PDA seed but stored for close constraint safety.
    pub user: Pubkey,      // 32
    /// True once this user has minted. Prevents double-mint even if the entry is not closed.
    pub has_minted: bool,  // 1
    /// Canonical bump for this user-specific PDA.
    pub bump: u8,          // 1
}

impl WhitelistEntry {
    // discriminator(8) + user(32) + has_minted(1) + bump(1)
    pub const LEN: usize = 8 + 32 + 1 + 1;
}

// ─────────────────────────────────────────────────────────────
// EVENTS
// ─────────────────────────────────────────────────────────────

#[event]
pub struct ConfigInitialized {
    pub authority: Pubkey,
    pub price: u64,
    pub max_supply: u32,
}

#[event]
pub struct UserWhitelisted {
    pub user: Pubkey,
}

#[event]
pub struct NftMinted {
    pub user: Pubkey,
    pub mint: Pubkey,
    pub supply_after: u32,
}

// ─────────────────────────────────────────────────────────────
// ERRORS
// ─────────────────────────────────────────────────────────────

#[error_code]
pub enum MintError {
    #[msg("Price must be greater than zero")]
    InvalidPrice,

    #[msg("Max supply must be greater than zero")]
    InvalidMaxSupply,

    #[msg("Signer is not the stored program authority")]
    UnauthorizedAuthority,

    #[msg("This user is not whitelisted for this mint")]
    NotWhitelisted,

    #[msg("This whitelist entry does not belong to the payer")]
    WhitelistMismatch,

    #[msg("This wallet has already minted — double-mint not allowed")]
    AlreadyMinted,

    #[msg("Max supply has been reached — no more NFTs can be minted")]
    MaxSupplyReached,

    #[msg("Metadata field cannot be empty")]
    EmptyMetadataField,

    #[msg("Metadata field exceeds maximum allowed length")]
    MetadataFieldTooLong,

    #[msg("Token metadata program ID does not match expected constant")]
    InvalidMetadataProgram,

    #[msg("Arithmetic overflow in supply counter or balance check")]
    ArithmeticOverflow,

    #[msg("Payer lost more SOL than expected during CPI — possible drain attack")]
    ExcessiveSolSpend,

    #[msg("Source and destination accounts must be different")]
    DuplicateAccount,
}
