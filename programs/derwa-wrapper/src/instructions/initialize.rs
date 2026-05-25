use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::error::DeRwaError;
use crate::state::WrapperConfig;

/// Args for `initialize` — the trust anchors that drive `unwrap`'s
/// attestation validation. These are immutable once the wrapper is
/// initialized: rotating them would require re-deploying the wrapper for
/// a new pool. Setting these at init time avoids any "open until first
/// use" window where unwrap would accept any-issuer attestations.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct InitializeWrapperArgs {
    /// Program that owns acceptable attestation accounts. Must be a real
    /// deployed program (mock-sas in tests, real SAS / Civic Pass in
    /// prod). `Pubkey::default()` is rejected with `InvalidAttestationConfig`.
    pub attestation_program: Pubkey,

    /// Expected `issuer` field on attestation payloads. The Brazilian
    /// compliance attester for a Cayman-LLC-wrapped FIDC pool, for
    /// example. `Pubkey::default()` is rejected with `InvalidAttestationConfig`.
    pub attestation_issuer: Pubkey,

    /// Required `attestation_type` byte. Encodes the KYC tier required
    /// for unwrap (e.g. 0 = generic KYC, 2 = accredited investor).
    pub required_attestation_type: u8,
}

/// Bind a pool to its (cPOOL, dePOOL) mint pair + capture the per-pool
/// trust posture for unwrap-time attestation validation.
///
/// Pre-conditions (enforced by the broader system, not by this ix):
///   1. The cPOOL mint exists with ComplianceHook in Permissioned mode,
///      created inside `initialize_pool`.
///   2. The dePOOL mint exists with ComplianceHook in FreelyTransferable
///      mode, created by `scripts/create-derwa-mint.ts` with its
///      MintConfig + ExtraAccountMetaList initialized.
///   3. The dePOOL mint authority is the `wrapper_signer` PDA (set by
///      the create-derwa-mint script).
///
/// Anchor doesn't reach into the mint extensions to validate (1) and (2)
/// here — the invariant is enforced at the binding sites. This handler
/// records the binding so `wrap` and `unwrap` can dispatch against the
/// correct mints AND so `unwrap` can validate the destination wallet's
/// attestation against the configured trust anchors.
#[derive(Accounts)]
#[instruction(args: InitializeWrapperArgs)]
pub struct InitializeWrapper<'info> {
    /// CHECK: pool's CreditVault PDA. Stored verbatim into `WrapperConfig.pool`.
    /// We don't deserialize because that would couple derwa-wrapper to svs-11's
    /// IDL (creating a circular build-time dep). The pool's CreditVault PDA is
    /// validated implicitly via the `wrapper_config` seed derivation: anyone
    /// passing a non-pool key here would derive a different `wrapper_config`
    /// PDA, which Anchor's `init` constraint would either succeed at (binding
    /// to the bogus key — harmless because no SVS-11 ix references it) or
    /// fail at if the bogus PDA already exists.
    pub pool: UncheckedAccount<'info>,

    /// Per-pool wrapper config. One per pool — Anchor's `init` constraint
    /// forbids re-init, which is the lock that prevents an attacker from
    /// re-binding the pool to a different (cPOOL, dePOOL) pair.
    #[account(
        init,
        payer = payer,
        space = WrapperConfig::SPACE,
        seeds = [WrapperConfig::SEED_PREFIX, pool.key().as_ref()],
        bump,
    )]
    pub wrapper_config: Account<'info, WrapperConfig>,

    /// Token-2022 cPOOL mint. Resolved via `InterfaceAccount` so Token-2022
    /// extensions (TransferHook etc.) deserialize correctly.
    pub permissioned_mint: InterfaceAccount<'info, Mint>,

    /// Token-2022 dePOOL mint (FreelyTransferable hook).
    pub derwa_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeWrapper>, args: InitializeWrapperArgs) -> Result<()> {
    // Reject default-pubkey trust anchors. Without this guard, an
    // operator could initialize a wrapper with `attestation_program ==
    // Pubkey::default()` and `attestation_issuer == Pubkey::default()`,
    // which would silently accept any account whose `owner` is the
    // default program (system program) and whose payload happens to
    // contain a default issuer pubkey — a clearly degenerate trust
    // posture that's easier to forbid up front than to reason about
    // later.
    require!(
        args.attestation_program != Pubkey::default(),
        DeRwaError::InvalidAttestationConfig
    );
    require!(
        args.attestation_issuer != Pubkey::default(),
        DeRwaError::InvalidAttestationConfig
    );

    let cfg = &mut ctx.accounts.wrapper_config;
    cfg.pool = ctx.accounts.pool.key();
    cfg.permissioned_mint = ctx.accounts.permissioned_mint.key();
    cfg.derwa_mint = ctx.accounts.derwa_mint.key();
    cfg.locked_supply = 0;
    cfg.bump = ctx.bumps.wrapper_config;
    cfg.attestation_program = args.attestation_program;
    cfg.attestation_issuer = args.attestation_issuer;
    cfg.required_attestation_type = args.required_attestation_type;

    emit!(crate::events::WrapperInitialized {
        pool: cfg.pool,
        permissioned_mint: cfg.permissioned_mint,
        derwa_mint: cfg.derwa_mint,
        attestation_program: cfg.attestation_program,
        attestation_issuer: cfg.attestation_issuer,
        required_attestation_type: cfg.required_attestation_type,
    });
    Ok(())
}
