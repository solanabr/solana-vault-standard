use anchor_lang::prelude::*;
use spl_transfer_hook_interface::error::TransferHookError;

use crate::error::ComplianceHookError;
use crate::state::{ComplianceMode, MintConfig, SanctionsList};

/// Canonical Token-2022 TransferHook account layout: source_ata, mint,
/// destination_ata, source_owner — followed by the resolved EAML extras.
/// Index order is load-bearing: the EAML's `Seed::AccountKey { index: N }`
/// entries reference these positions. Permissioned-mode extras
/// (attestation_program, source_attestation, destination_attestation,
/// pool_policy) are read from `ctx.remaining_accounts` instead of typed
/// fields, because Anchor 0.31's `Option<T>` binding cannot represent the
/// FreelyTransferable case (no extras) and the Permissioned case (4 extras)
/// uniformly.
#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: source ATA — owner read at offset 32..64.
    pub source_ata: UncheckedAccount<'info>,

    /// CHECK: mint (validated via mint_config seed).
    pub mint: UncheckedAccount<'info>,

    /// CHECK: destination ATA — owner read at offset 32..64.
    pub destination_ata: UncheckedAccount<'info>,

    /// CHECK: source owner authority.
    pub source_owner: UncheckedAccount<'info>,

    /// CHECK: ExtraAccountMetaList PDA. Token-2022's `invoke_execute`
    /// inserts THIS at CPI index 4 (BEFORE the resolved EAML extras),
    /// shifting `mint_config`/`sanctions_list`/etc. by +1. Surfaced here
    /// + seed-constrained so a forged value can't be substituted.
    #[account(
        seeds = [crate::instructions::initialize_extra_account_meta_list::EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    #[account(
        seeds = [MintConfig::SEED_PREFIX, mint.key().as_ref()],
        bump,
    )]
    pub mint_config: Account<'info, MintConfig>,

    #[account(
        seeds = [SanctionsList::SEED_PREFIX],
        bump,
    )]
    pub sanctions_list: Account<'info, SanctionsList>,

    /// CHECK: `FrozenAccount` PDA for source. Existence = frozen; absent
    /// = default-zero (lamports == 0 && data.len() == 0).
    pub source_frozen_check: UncheckedAccount<'info>,

    /// CHECK: `FrozenAccount` PDA for destination. Same semantics.
    pub destination_frozen_check: UncheckedAccount<'info>,
    // remaining_accounts in Permissioned mode:
    //   [0] attestation_program  [1] source_attestation
    //   [2] destination_attestation  [3] pool_policy (reserved)
}

/// Token-2022 ATA owner pubkey lives at bytes 32..64.
fn ata_owner(ata: &AccountInfo) -> Result<Pubkey> {
    let data = ata.try_borrow_data()?;
    if data.len() < 64 {
        return Err(ProgramError::from(TransferHookError::IncorrectAccount).into());
    }
    Pubkey::try_from(&data[32..64])
        .map_err(|_| -> Error { ProgramError::from(TransferHookError::IncorrectAccount).into() })
}

pub fn handler(ctx: Context<Execute>) -> Result<()> {
    let source_owner = ata_owner(&ctx.accounts.source_ata)?;
    let dest_owner = ata_owner(&ctx.accounts.destination_ata)?;

    let sl = &ctx.accounts.sanctions_list;
    require!(
        !sl.contains(&source_owner) && !sl.contains(&dest_owner),
        ComplianceHookError::SanctionedAddress
    );

    let src_frozen = ctx.accounts.source_frozen_check.lamports() > 0
        && ctx.accounts.source_frozen_check.data_len() > 0;
    let dst_frozen = ctx.accounts.destination_frozen_check.lamports() > 0
        && ctx.accounts.destination_frozen_check.data_len() > 0;
    require!(
        !src_frozen && !dst_frozen,
        ComplianceHookError::AccountFrozen
    );

    match ctx.accounts.mint_config.mode {
        ComplianceMode::FreelyTransferable => Ok(()),
        ComplianceMode::Permissioned => {
            const PERMISSIONED_REMAINING_COUNT: usize = 4;
            require!(
                ctx.remaining_accounts.len() == PERMISSIONED_REMAINING_COUNT,
                ComplianceHookError::AttestationNotFound
            );
            let attestation_program_acct = &ctx.remaining_accounts[0];
            require_keys_eq!(
                attestation_program_acct.key(),
                ctx.accounts.mint_config.attestation_program,
                ComplianceHookError::InvalidAttestationProgram
            );

            let src_att = &ctx.remaining_accounts[1];
            let dst_att = &ctx.remaining_accounts[2];

            check_attestation(src_att, &source_owner, &ctx.accounts.mint_config)?;
            check_attestation(dst_att, &dest_owner, &ctx.accounts.mint_config)?;

            // pool_policy (remaining_accounts[3]) reserved for future
            // jurisdiction / investor_class / kyc_risk_tier enforcement.
            Ok(())
        }
    }
}

/// Validates an SVS-11 Attestation account against `mint_config`'s trust
/// anchors. The canonical-PDA check (step 8) atomically binds steps 3-5:
/// any subject/issuer/type mismatch would produce a different PDA, so a
/// forged payload satisfying 3-5 individually still fails 8.
///
/// Field offsets MUST stay in sync with `svs-11/src/attestation.rs` AND
/// `derwa-wrapper/src/instructions/unwrap.rs` (parallel reader). Offsets
/// after the 8-byte discriminator:
///   0..32  subject  | 32..64  issuer  | 64  type  | 65..67  country
///   67..75  issued_at  | 75..83  expires_at  | 83  revoked  | 84  bump
fn check_attestation(
    att: &AccountInfo,
    expected_subject: &Pubkey,
    mint_config: &MintConfig,
) -> Result<()> {
    require!(
        att.owner == &mint_config.attestation_program,
        ComplianceHookError::InvalidAttestationProgram
    );
    require!(
        att.lamports() > 0 && att.data_len() > 0,
        ComplianceHookError::AttestationNotFound
    );

    let data = att.try_borrow_data()?;
    require!(data.len() >= 129, ComplianceHookError::AttestationNotFound);

    let payload = &data[8..];
    let bytes_at = |range: std::ops::Range<usize>| -> Result<[u8; 32]> {
        payload[range]
            .try_into()
            .map_err(|_| -> Error { error!(ComplianceHookError::AttestationNotFound) })
    };

    let subject = Pubkey::new_from_array(bytes_at(0..32)?);
    require!(
        &subject == expected_subject,
        ComplianceHookError::InvalidAttestationSubject
    );

    let issuer = Pubkey::new_from_array(bytes_at(32..64)?);
    require!(
        issuer == mint_config.attestation_issuer,
        ComplianceHookError::InvalidAttestationIssuer
    );

    let attestation_type = payload[64];
    require!(
        attestation_type == mint_config.required_attestation_type,
        ComplianceHookError::InvalidAttestationType
    );

    let revoked = payload[83] != 0;
    require!(!revoked, ComplianceHookError::AttestationRevoked);

    let expires_bytes: [u8; 8] = payload[75..83]
        .try_into()
        .map_err(|_| -> Error { error!(ComplianceHookError::AttestationNotFound) })?;
    let expires_at = i64::from_le_bytes(expires_bytes);
    let now = Clock::get()?.unix_timestamp;
    require!(now < expires_at, ComplianceHookError::AttestationExpired);

    let bump = payload[84];
    let expected_pda = Pubkey::create_program_address(
        &[
            b"attestation",
            subject.as_ref(),
            issuer.as_ref(),
            &[attestation_type],
            &[bump],
        ],
        &mint_config.attestation_program,
    )
    .map_err(|_| -> Error { error!(ComplianceHookError::InvalidAttestationPda) })?;
    require!(
        att.key() == expected_pda,
        ComplianceHookError::InvalidAttestationPda
    );

    Ok(())
}
