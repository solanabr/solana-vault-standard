use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{
        spl_token_2022::{
            extension::{
                transfer_hook::instruction::initialize as initialize_transfer_hook, ExtensionType,
            },
            instruction::{initialize_account3, initialize_mint2},
        },
        Token2022,
    },
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::constants::{
    COMPLIANCE_HOOK_PROGRAM_ID, MAX_DECIMALS, REDEMPTION_ESCROW_SEED, SHARES_DECIMALS,
    SHARES_MINT_SEED, VAULT_SEED,
};
use crate::error::VaultError;
use crate::events::VaultInitialized;
use crate::state::CreditVault;

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub manager: SystemAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = CreditVault::LEN,
        seeds = [VAULT_SEED, asset_mint.key().as_ref(), &vault_id.to_le_bytes()],
        bump
    )]
    pub vault: Box<Account<'info, CreditVault>>,

    pub asset_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: Shares mint (cPOOL) initialized via CPI in handler. The
    /// handler binds the Token-2022 TransferHook extension pointing at
    /// COMPLIANCE_HOOK_PROGRAM_ID before mint init so all shares-mint
    /// transfers route through the compliance-hook program.
    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
        bump
    )]
    pub shares_mint: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        associated_token::mint = asset_mint,
        associated_token::authority = vault,
        associated_token::token_program = asset_token_program,
    )]
    pub deposit_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: Redemption escrow initialized via CPI in handler
    #[account(
        mut,
        seeds = [REDEMPTION_ESCROW_SEED, vault.key().as_ref()],
        bump
    )]
    pub redemption_escrow: UncheckedAccount<'info>,

    /// CHECK: Oracle account validated when prices are consumed
    pub nav_oracle: UncheckedAccount<'info>,

    /// CHECK: Oracle program account stored for runtime validation
    pub oracle_program: UncheckedAccount<'info>,

    /// CHECK: Attester (issuer) pubkey stored for attestation validation
    pub attester: UncheckedAccount<'info>,

    /// CHECK: Attestation program owner stored for attestation validation
    pub attestation_program: UncheckedAccount<'info>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<InitializePool>,
    vault_id: u64,
    minimum_investment: u64,
    max_staleness: i64,
) -> Result<()> {
    require!(
        ctx.accounts.oracle_program.key() != Pubkey::default(),
        VaultError::InvalidAddress
    );
    require!(
        ctx.accounts.nav_oracle.key() != Pubkey::default(),
        VaultError::InvalidAddress
    );
    require!(
        ctx.accounts.attester.key() != Pubkey::default(),
        VaultError::InvalidAddress
    );
    require!(
        ctx.accounts.oracle_program.executable,
        VaultError::OracleInvalidProgram
    );
    require!(
        ctx.accounts.attestation_program.executable,
        VaultError::InvalidAttestationProgram
    );

    let asset_decimals = ctx.accounts.asset_mint.decimals;
    require!(
        asset_decimals <= MAX_DECIMALS,
        VaultError::InvalidAssetDecimals
    );

    let vault_key = ctx.accounts.vault.key();
    let vault_bump = ctx.bumps.vault;
    let shares_mint_bump = ctx.bumps.shares_mint;
    let redemption_escrow_bump = ctx.bumps.redemption_escrow;

    // The cPOOL mint MUST allocate space for the TransferHook extension.
    // Pass `&[ExtensionType::TransferHook]` so the mint account is large
    // enough for both the base Mint state AND the hook extension TLV.
    // Without the extension in this calc, the mint would later fail to
    // add the extension during initialize_transfer_hook.
    let mint_size = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(&[
        ExtensionType::TransferHook,
    ])
    .map_err(|_| VaultError::MathOverflow)?;

    // Token-2022 requires the redemption_escrow account to be sized
    // for `TransferHookAccount` because its mint
    // (cPOOL shares_mint) carries the `TransferHook` extension. The
    // SPL-Token-2022 spec maps every mint extension to an
    // `Initialize{Account,Mint}` requirement; for TransferHook the
    // companion is `TransferHookAccount` (a 1-byte transferring flag).
    // Without sizing for it, `initialize_account3` on the escrow returns
    // `InvalidAccountData` (the runtime checks the account length matches
    // the required-init-account-extensions sum).
    //
    // Note: `initialize_transfer_hook_account` itself is NOT a separate
    // ix — Token-2022 implicitly initializes the per-account TransferHook
    // state inside `initialize_account3` when the underlying mint has the
    // extension. We just need to allocate the right number of bytes.
    let token_account_size = ExtensionType::try_calculate_account_len::<
        spl_token_2022::state::Account,
    >(&[ExtensionType::TransferHookAccount])
    .map_err(|_| VaultError::MathOverflow)?;

    let rent = &ctx.accounts.rent;
    let mint_lamports = rent.minimum_balance(mint_size);
    let escrow_lamports = rent.minimum_balance(token_account_size);

    let shares_mint_bump_bytes = [shares_mint_bump];
    let shares_mint_seeds: &[&[u8]] = &[
        SHARES_MINT_SEED,
        vault_key.as_ref(),
        &shares_mint_bump_bytes,
    ];

    let asset_mint_key = ctx.accounts.asset_mint.key();
    let vault_id_bytes = vault_id.to_le_bytes();
    let vault_bump_bytes = [vault_bump];
    let vault_seeds: &[&[u8]] = &[
        VAULT_SEED,
        asset_mint_key.as_ref(),
        &vault_id_bytes,
        &vault_bump_bytes,
    ];

    let redemption_escrow_bump_bytes = [redemption_escrow_bump];
    let redemption_escrow_seeds: &[&[u8]] = &[
        REDEMPTION_ESCROW_SEED,
        vault_key.as_ref(),
        &redemption_escrow_bump_bytes,
    ];

    // Create shares mint account (sized for base mint + TransferHook ext).
    invoke_signed(
        &anchor_lang::solana_program::system_instruction::create_account(
            &ctx.accounts.authority.key(),
            &ctx.accounts.shares_mint.key(),
            mint_lamports,
            mint_size as u64,
            &ctx.accounts.token_2022_program.key(),
        ),
        &[
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.shares_mint.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[shares_mint_seeds],
    )?;

    // Bind the TransferHook extension BEFORE initializing the mint.
    // Token-2022 requires extension init in this order: create account
    // → init extensions → init base mint state.
    //
    // The hook authority is set to the pool admin (`authority`) at
    // first deploy so hot-fix flexibility is preserved. Production
    // deployments should rotate this authority to their configured
    // governance authority.
    //
    // CROSS-PROGRAM INVARIANT: the cPOOL mint now points at
    // COMPLIANCE_HOOK_PROGRAM_ID, but the dependent PDAs that
    // compliance-hook expects (per-mint `MintConfig` and per-mint
    // `ExtraAccountMetaList`) are initialized by a SEPARATE follow-up
    // svs-11 instruction `bootstrap_shares_compliance`, which CPIs
    // into compliance-hook with `vault_seeds` so the vault PDA — which
    // becomes the cPOOL mint authority below — satisfies
    // compliance-hook's `Signer == mint_authority` constraint via
    // Anchor's `invoke_signed` flow.
    //
    // The split is intentional: keeping the compliance-hook bootstrap
    // out of `initialize_pool` lets `bootstrap_shares_compliance` carry
    // the per-mint trust anchors (attestation_program /
    // attestation_issuer / required_attestation_type) without
    // bloating this struct's accounts list, and it lets operators
    // bind cPOOL in `FreelyTransferable` mode initially and flip to
    // `Permissioned` later by re-init'ing the EAML — without re-deploying
    // the pool itself.
    invoke(
        &initialize_transfer_hook(
            &ctx.accounts.token_2022_program.key(),
            &ctx.accounts.shares_mint.key(),
            Some(ctx.accounts.authority.key()),
            Some(COMPLIANCE_HOOK_PROGRAM_ID),
        )?,
        &[ctx.accounts.shares_mint.to_account_info()],
    )?;

    // Initialize shares mint (vault PDA is mint authority).
    invoke_signed(
        &initialize_mint2(
            &ctx.accounts.token_2022_program.key(),
            &ctx.accounts.shares_mint.key(),
            &vault_key,
            None,
            SHARES_DECIMALS,
        )?,
        &[ctx.accounts.shares_mint.to_account_info()],
        &[vault_seeds],
    )?;

    // Create redemption escrow account
    invoke_signed(
        &anchor_lang::solana_program::system_instruction::create_account(
            &ctx.accounts.authority.key(),
            &ctx.accounts.redemption_escrow.key(),
            escrow_lamports,
            token_account_size as u64,
            &ctx.accounts.token_2022_program.key(),
        ),
        &[
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.redemption_escrow.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[redemption_escrow_seeds],
    )?;

    // Initialize redemption escrow as a token account (mint = shares_mint, authority = vault PDA)
    invoke_signed(
        &initialize_account3(
            &ctx.accounts.token_2022_program.key(),
            &ctx.accounts.redemption_escrow.key(),
            &ctx.accounts.shares_mint.key(),
            &vault_key,
        )?,
        &[
            ctx.accounts.redemption_escrow.to_account_info(),
            ctx.accounts.shares_mint.to_account_info(),
        ],
        &[vault_seeds],
    )?;

    let vault = &mut ctx.accounts.vault;
    vault.authority = ctx.accounts.authority.key();
    vault.manager = ctx.accounts.manager.key();
    vault.asset_mint = ctx.accounts.asset_mint.key();
    vault.shares_mint = ctx.accounts.shares_mint.key();
    vault.deposit_vault = ctx.accounts.deposit_vault.key();
    vault.redemption_escrow = ctx.accounts.redemption_escrow.key();
    vault.nav_oracle = ctx.accounts.nav_oracle.key();
    vault.oracle_program = ctx.accounts.oracle_program.key();
    svs_oracle::validate_staleness_config(max_staleness)
        .map_err(|_| VaultError::InvalidStalenessConfig)?;
    vault.max_staleness = max_staleness;
    vault.attester = ctx.accounts.attester.key();
    vault.attestation_program = ctx.accounts.attestation_program.key();
    vault.vault_id = vault_id;
    vault.total_assets = 0;
    vault.total_shares = 0;
    vault.total_pending_deposits = 0;
    vault.minimum_investment = minimum_investment;
    vault.investment_window_open = false;
    vault.bump = vault_bump;
    vault.redemption_escrow_bump = redemption_escrow_bump;
    vault.paused = false;
    vault.total_approved_deposits = 0;
    vault.pending_authority = Pubkey::default();
    vault.total_pending_redeems = 0;
    vault.required_attestation_type = 0;
    vault._reserved = [0u8; 23];

    vault.last_seen_nav_sequence = 0;
    vault._padding_oracle = [0u8; 24];

    msg!(
        "initialize_pool COMPLETE | shares_mint={} hook={} | NEXT STEP (deployment runbook): \
         init MintConfig + EAML + infrastructure attestations. Publish the configured \
         oracle account ({}) before opening the investment window.",
        ctx.accounts.shares_mint.key(),
        COMPLIANCE_HOOK_PROGRAM_ID,
        ctx.accounts.nav_oracle.key(),
    );

    emit!(VaultInitialized {
        vault: vault.key(),
        authority: vault.authority,
        manager: vault.manager,
        asset_mint: vault.asset_mint,
        shares_mint: vault.shares_mint,
        vault_id,
    });

    Ok(())
}
