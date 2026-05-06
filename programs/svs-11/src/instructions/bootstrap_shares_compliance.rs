//! Bootstrap the compliance-hook `MintConfig` + `ExtraAccountMetaList`
//! PDAs for a CreditVault's shares mint (cPOOL).
//!
//! ── ARCHITECTURE ──────────────────────────────────────────────────────
//! `initialize_pool` creates the shares mint with the Token-2022
//! `TransferHook` extension bound to `compliance-hook` and sets the
//! vault PDA as the mint authority. compliance-hook's typed init
//! handlers (`initialize_mint_config`, `initialize_extra_account_meta_list`)
//! both require a `Signer == mint_authority` to authorize the binding.
//! Since vault is a PDA, that signer must come from `invoke_signed`
//! inside an svs-11 instruction — which is what this handler does:
//! it CPIs into compliance-hook with `vault_seeds`, satisfying the
//! `Signer` constraint without requiring a separate top-level call.
//!
//! Anchor's `init` constraint composes correctly through this CPI:
//! init'd PDAs are emitted with `is_signer: false` in
//! `to_account_metas` (only the explicit `signer` constraint sets the
//! flag), and the PDA's signature for `system_program::create_account`
//! is supplied INSIDE compliance-hook via
//! `CpiContext::with_signer(&[seeds_with_nonce])`. The outer svs-11
//! caller does not need to prove any privilege over the cross-program
//! PDA being created — that's compliance-hook's responsibility, and
//! it's discharged by Anchor's macro expansion of `init`.
//!
//! ── BOOTSTRAP FLOW ────────────────────────────────────────────────────
//! Operator workflow after `initialize_pool`:
//!
//!   1. Initialize the singleton compliance-hook `SanctionsList` if
//!      it doesn't already exist (one-shot per program deployment;
//!      the runbook handles this once and skips on subsequent pools).
//!   2. For each pool, call `bootstrap_shares_compliance` with the
//!      mode and trust anchors. svs-11 CPIs into compliance-hook with
//!      `vault_seeds` and creates the per-mint MintConfig + EAML.
//!   3. For Permissioned mode, the operator separately issues:
//!        a. An infrastructure attestation for the `vault` PDA via
//!           the configured attestation program (mock-sas / SAS).
//!           This attestation has `subject = vault.key()` and is
//!           required because `redemption_escrow.owner == vault`, so
//!           Permissioned-mode hooks validate `vault`'s attestation
//!           on the destination side of `request_redeem`'s cPOOL
//!           transfer.
//!        b. Per-investor attestations as investors onboard (via
//!           the standard per-wallet KYB flow).
//!   4. Investor calls `request_redeem` with the resolved hook extras
//!      passed via `remainingAccounts`. svs-11's `request_redeem`
//!      handler extends the inner `transfer_checked` ix with
//!      `add_extra_accounts_for_execute_cpi` so Token-2022 can invoke
//!      the hook with full identity binding.

use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::Mint;

use crate::constants::{COMPLIANCE_HOOK_PROGRAM_ID, VAULT_SEED};
use crate::error::VaultError;
use crate::state::CreditVault;

use compliance_hook::cpi::accounts::{
    InitializeExtraAccountMetaList as ComplianceHookInitEaml,
    InitializeMintConfig as ComplianceHookInitMintConfig,
};
use compliance_hook::program::ComplianceHook;
use compliance_hook::{
    state::{ComplianceMode as ComplianceHookMode, MintConfig},
    InitializeMintConfigArgs as ComplianceHookInitMintConfigArgs,
};

/// Args for `bootstrap_shares_compliance`. Mirror the relevant fields
/// from `compliance_hook::InitializeMintConfigArgs` so the operator can
/// configure the per-mint enforcement posture in a single CPI without
/// having to assemble the underlying compliance-hook arg type.
///
/// Two variants are accepted:
///
///   - **FreelyTransferable**: trust anchors are stored but unused by
///     the hook. Operators typically pass `Pubkey::default()` for both
///     program / issuer and `0` for the type. Pool policy must be `None`
///     (compliance-hook rejects a `Some` value in FreelyTransferable
///     mode).
///   - **Permissioned**: trust anchors are required (non-default), and
///     `pool_policy` must be `Some(_)`. compliance-hook validates these
///     invariants and rejects with `MissingPoolPolicyForPermissioned`
///     or `InvalidAttestationConfig` on violation.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct BootstrapSharesComplianceArgs {
    /// Compliance mode for the cPOOL shares mint.
    pub mode: BootstrapComplianceMode,
    /// Optional pool-policy PDA. Required `Some` when `mode` is
    /// `Permissioned`; required `None` when `FreelyTransferable`.
    pub pool_policy: Option<Pubkey>,
    /// Attestation program (e.g. mock-sas / real SAS). Required
    /// non-default for `Permissioned`; ignored for `FreelyTransferable`
    /// (caller may pass `Pubkey::default()`).
    pub attestation_program: Pubkey,
    /// Expected `issuer` field on attestation payloads. Required
    /// non-default for `Permissioned`.
    pub attestation_issuer: Pubkey,
    /// Required `attestation_type` byte. Encodes the KYC tier.
    pub required_attestation_type: u8,
}

/// Mirror of `compliance_hook::ComplianceMode` so we can accept the
/// arg over the wire without exposing the upstream type directly. The
/// handler maps this 1:1 to `ComplianceHookMode` via `From`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BootstrapComplianceMode {
    FreelyTransferable,
    Permissioned,
}

impl From<BootstrapComplianceMode> for ComplianceHookMode {
    fn from(value: BootstrapComplianceMode) -> Self {
        match value {
            BootstrapComplianceMode::FreelyTransferable => ComplianceHookMode::FreelyTransferable,
            BootstrapComplianceMode::Permissioned => ComplianceHookMode::Permissioned,
        }
    }
}

#[derive(Accounts)]
pub struct BootstrapSharesCompliance<'info> {
    /// Pool authority. Same identity that called `initialize_pool` —
    /// gates this bootstrap step so an attacker cannot front-run the
    /// runbook and bind a different mode to a freshly-initialized
    /// pool's cPOOL.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Existing CreditVault. Anchor's `has_one = authority` constraint
    /// rejects callers that don't match the recorded pool authority.
    #[account(
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        has_one = authority @ VaultError::Unauthorized,
        constraint = vault.shares_mint == shares_mint.key() @ VaultError::InvalidMintAccount,
    )]
    pub vault: Box<Account<'info, CreditVault>>,

    /// cPOOL mint — the `mint_authority` field on this Mint must equal
    /// `vault.key()` (verified inside compliance-hook's
    /// `initialize_mint_config` handler against the unpacked Token-2022
    /// state). The CPI below passes vault as `mint_authority` signer
    /// via `vault_seeds`.
    pub shares_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: PDA at `[b"mint_config", shares_mint]` under the
    /// compliance-hook program ID. compliance-hook's `init` constraint
    /// validates the seed derivation; we only assert it's address-derivable
    /// here so the CPI doesn't fail on a malformed input.
    #[account(
        mut,
        seeds = [MintConfig::SEED_PREFIX, shares_mint.key().as_ref()],
        bump,
        seeds::program = COMPLIANCE_HOOK_PROGRAM_ID,
    )]
    pub mint_config: UncheckedAccount<'info>,

    /// CHECK: PDA at `[b"extra-account-metas", shares_mint]` under
    /// the compliance-hook program ID (note the HYPHEN — Token-2022's
    /// canonical seed literal). Validated by compliance-hook's `init`
    /// constraint.
    #[account(
        mut,
        seeds = [b"extra-account-metas", shares_mint.key().as_ref()],
        bump,
        seeds::program = COMPLIANCE_HOOK_PROGRAM_ID,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// compliance-hook program for the CPI dispatch.
    pub compliance_hook_program: Program<'info, ComplianceHook>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<BootstrapSharesCompliance>,
    args: BootstrapSharesComplianceArgs,
) -> Result<()> {
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let vault_bump_bytes = [ctx.accounts.vault.bump];
    let vault_seeds: &[&[u8]] = &[
        VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &vault_bump_bytes,
    ];
    let vault_signer_seeds: &[&[&[u8]]] = &[vault_seeds];

    // Step 1: CPI into compliance-hook::initialize_mint_config with
    // vault as mint_authority. The vault PDA's signature flows in via
    // invoke_signed's signer_seeds; compliance-hook's handler reads
    // the unpacked Mint state, sees `mint.mint_authority == vault.key()`,
    // and accepts the binding.
    compliance_hook::cpi::initialize_mint_config(
        CpiContext::new_with_signer(
            ctx.accounts.compliance_hook_program.to_account_info(),
            ComplianceHookInitMintConfig {
                mint_config: ctx.accounts.mint_config.to_account_info(),
                mint: ctx.accounts.shares_mint.to_account_info(),
                mint_authority: ctx.accounts.vault.to_account_info(),
                payer: ctx.accounts.authority.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            vault_signer_seeds,
        ),
        ComplianceHookInitMintConfigArgs {
            mode: args.mode.into(),
            pool_policy: args.pool_policy,
            attestation_program: args.attestation_program,
            attestation_issuer: args.attestation_issuer,
            required_attestation_type: args.required_attestation_type,
        },
    )?;

    // Step 2: CPI into compliance-hook::initialize_extra_account_meta_list.
    // Same vault_seeds for the mint_authority signer; compliance-hook's
    // handler reads MintConfig (just created in step 1) for the mode +
    // trust anchors, and writes the EAML PDA accordingly (4 entries
    // for FreelyTransferable, 8 for Permissioned).
    compliance_hook::cpi::initialize_extra_account_meta_list(CpiContext::new_with_signer(
        ctx.accounts.compliance_hook_program.to_account_info(),
        ComplianceHookInitEaml {
            extra_account_meta_list: ctx.accounts.extra_account_meta_list.to_account_info(),
            mint: ctx.accounts.shares_mint.to_account_info(),
            mint_config: ctx.accounts.mint_config.to_account_info(),
            mint_authority: ctx.accounts.vault.to_account_info(),
            payer: ctx.accounts.authority.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
        vault_signer_seeds,
    ))?;

    emit!(crate::events::SharesComplianceBootstrapped {
        vault: ctx.accounts.vault.key(),
        shares_mint: ctx.accounts.shares_mint.key(),
        mode: args.mode,
        attestation_program: args.attestation_program,
    });

    Ok(())
}
