use anchor_lang::prelude::*;

use crate::state::{ComplianceMode, MintConfig};

/// Args for `initialize_mint_config`. Carries the per-mint enforcement
/// posture so the hook's `execute` ix can branch on it without further
/// state lookup.
///
/// Trust-anchor fields (`attestation_program`, `attestation_issuer`,
/// `required_attestation_type`) are required when `mode == Permissioned`.
/// They drive the full identity-binding validation in
/// `execute::check_attestation`. For `FreelyTransferable`, these fields
/// are accepted but ignored — a sane operator pattern is to set them to
/// `Pubkey::default()` and `0` respectively for clarity.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct InitializeMintConfigArgs {
    /// Mode this mint operates under. `FreelyTransferable` skips
    /// attestation checks (used for dePOOL-style freely-transferable
    /// wrappers); `Permissioned` enforces source+destination attestations
    /// every transfer.
    pub mode: ComplianceMode,
    /// Optional pool-policy PDA. Only meaningful in `Permissioned` mode
    /// where it gates jurisdiction / investor-class / KYC-tier rules.
    /// `None` for `FreelyTransferable` mints.
    pub pool_policy: Option<Pubkey>,
    /// Program that owns acceptable attestation accounts. Validated by
    /// `execute::check_attestation` against the passed accounts' `owner`.
    /// REQUIRED (non-default) for Permissioned mode.
    pub attestation_program: Pubkey,
    /// Expected `issuer` field on attestation payloads. REQUIRED
    /// (non-default) for Permissioned mode.
    pub attestation_issuer: Pubkey,
    /// Required `attestation_type` byte (e.g. 0 = generic KYC,
    /// 2 = accredited investor). Has no enforced default, but typically
    /// 0 for FreelyTransferable mints.
    pub required_attestation_type: u8,
}

/// Initializes the per-mint config PDA that the `execute` hook reads on
/// every transfer.
///
/// Authorization: the signer MUST be the Token-2022 mint authority for
/// the bound mint. Token-2022's `Mint::mint_authority` is a `COption`
/// (`Option`-shaped); we read it via `mint.mint_authority` and compare to
/// the signer's pubkey, rejecting if the mint is uninitialized or the
/// signer doesn't match.
///
/// Token-2022 binding: the handler also asserts
/// `mint.owner == spl_token_2022::id()`. Without this, the
/// `Mint::unpack` below would happily decode a legacy SPL Token mint
/// (whose layout matches Token-2022's base layout) — and the resulting
/// `MintConfig` would bind a hook to a mint that physically can't carry
/// a TransferHook extension. Failing fast here at init time avoids a
/// silent mode mismatch later.
///
/// The `payer` exists so a separate operator key (cheaper to fund) can
/// pay rent without holding mint authority. This is the common deploy
/// pattern: a "deployer" funds account creation; a "mint authority"
/// (often a PDA from another program) approves the binding.
#[derive(Accounts)]
#[instruction(args: InitializeMintConfigArgs)]
pub struct InitializeMintConfig<'info> {
    #[account(
        init,
        payer = payer,
        space = MintConfig::SPACE,
        seeds = [MintConfig::SEED_PREFIX, mint.key().as_ref()],
        bump,
    )]
    pub mint_config: Account<'info, MintConfig>,

    /// CHECK: Token-2022 mint we're binding to. We read `mint_authority`
    /// off the deserialized mint state in the handler — Anchor doesn't
    /// know about Token-2022 extensions in the IDL but the raw account
    /// data is canonical SPL Token, so a manual unpack reads the
    /// `mint_authority` field at the standard offset. The handler also
    /// validates `mint.owner == spl_token_2022::id()` to reject
    /// legacy SPL mints.
    pub mint: AccountInfo<'info>,

    /// Mint authority signer — must match `mint.mint_authority`. The
    /// handler verifies this; failure yields `UnauthorizedAuthority`.
    pub mint_authority: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeMintConfig>, args: InitializeMintConfigArgs) -> Result<()> {
    use anchor_lang::solana_program::program_pack::Pack;
    use anchor_spl::token_2022::spl_token_2022;
    use anchor_spl::token_2022::spl_token_2022::state::Mint as Token2022Mint;

    // (audit #8) Reject legacy-SPL mints. The base layout is identical
    // to Token-2022's, so `Mint::unpack` would happily decode either —
    // but only Token-2022 mints can physically carry a TransferHook
    // extension. Binding a hook MintConfig to a legacy SPL mint would
    // produce a configuration that's structurally valid but
    // unenforceable, since legacy SPL doesn't invoke transfer hooks.
    require_keys_eq!(
        *ctx.accounts.mint.owner,
        spl_token_2022::id(),
        crate::error::ComplianceHookError::InvalidMintAccount
    );

    let mint_data = ctx.accounts.mint.try_borrow_data()?;
    let mint_state = Token2022Mint::unpack(&mint_data[..Token2022Mint::LEN])
        .map_err(|_| crate::error::ComplianceHookError::InvalidMintAccount)?;

    // mint_authority is COption<Pubkey>: None for fixed-supply mints
    // (which can't have a MintConfig anyway since no one can authorize
    // the binding). We refuse those explicitly. The intermediate
    // `Option<Pubkey>` annotation pins COption's `Into` impl.
    let mint_authority_opt: Option<Pubkey> = mint_state.mint_authority.into();
    let actual_authority: Pubkey =
        mint_authority_opt.ok_or(crate::error::ComplianceHookError::UnauthorizedAuthority)?;

    require_keys_eq!(
        actual_authority,
        ctx.accounts.mint_authority.key(),
        crate::error::ComplianceHookError::UnauthorizedAuthority
    );

    // pool_policy MUST be Some when mode is Permissioned, and
    // MUST be None when mode is FreelyTransferable. Mixing them silently
    // would let a Permissioned mint skip policy checks (because
    // ExtraAccountMetaList wouldn't resolve a pool_policy account at all
    // when the field is None) — which would defeat the point of
    // Permissioned mode.
    match (args.mode, args.pool_policy) {
        (ComplianceMode::Permissioned, None) => {
            return err!(crate::error::ComplianceHookError::MissingPoolPolicyForPermissioned);
        }
        (ComplianceMode::FreelyTransferable, Some(_)) => {
            return err!(crate::error::ComplianceHookError::PoolPolicySetOnFreelyTransferable);
        }
        _ => {}
    }

    // Trust-anchor validation: in Permissioned mode, the attestation
    // program AND issuer MUST be set (non-default). A default-pubkey
    // trust anchor would silently accept any account whose `owner` is
    // the system program and whose payload happens to contain a default
    // issuer pubkey — a degenerate posture that's easier to forbid up
    // front than to reason about later. `required_attestation_type` has
    // no default-rejection because 0 is a meaningful "generic KYC" tier.
    if args.mode == ComplianceMode::Permissioned {
        require_keys_neq!(
            args.attestation_program,
            Pubkey::default(),
            crate::error::ComplianceHookError::InvalidAttestationConfig
        );
        require_keys_neq!(
            args.attestation_issuer,
            Pubkey::default(),
            crate::error::ComplianceHookError::InvalidAttestationConfig
        );
    }

    let cfg = &mut ctx.accounts.mint_config;
    cfg.mint = ctx.accounts.mint.key();
    cfg.mode = args.mode;
    cfg.pool_policy = args.pool_policy;
    cfg.attestation_program = args.attestation_program;
    cfg.attestation_issuer = args.attestation_issuer;
    cfg.required_attestation_type = args.required_attestation_type;

    emit!(MintConfigInitialized {
        mint: cfg.mint,
        mode: cfg.mode,
        attestation_program: cfg.attestation_program,
        attestation_issuer: cfg.attestation_issuer,
        required_attestation_type: cfg.required_attestation_type,
    });

    Ok(())
}

#[event]
pub struct MintConfigInitialized {
    /// The Token-2022 mint this config governs.
    pub mint: Pubkey,
    /// `FreelyTransferable` or `Permissioned`.
    pub mode: crate::state::ComplianceMode,
    /// Attestation program ID (`Pubkey::default()` in FreelyTransferable mode).
    pub attestation_program: Pubkey,
    /// Attestation issuer (`Pubkey::default()` in FreelyTransferable mode).
    pub attestation_issuer: Pubkey,
    /// Required attestation type discriminator (0 = generic KYC).
    pub required_attestation_type: u8,
}
