use anchor_lang::prelude::*;
use spl_transfer_hook_interface::error::TransferHookError;

use crate::error::ComplianceHookError;
use crate::state::{ComplianceMode, MintConfig, SanctionsList};

/// `Execute` accounts: order MUST match the canonical Token-2022 TransferHook
/// layout — `source_ata`, `mint`, `destination_ata`, `source_owner` — followed
/// by the compliance-hook extras. The extra-account-meta-list (built in
/// `initialize_extra_account_meta_list`) derives the extra account seeds via
/// `Seed::AccountKey { index: N }` against these positions, so the order here
/// is load-bearing.
///
/// Permissioned-mode extras (`attestation_program`, `source_attestation`,
/// `destination_attestation`, `pool_policy`) come in via
/// `ctx.remaining_accounts` rather than typed fields on this struct.
/// Anchor 0.31's `Option<T>` account binding requires explicit placeholder
/// pubkeys for missing accounts and does NOT silently bind `None` when the
/// runtime invokes with a truncated account list (the FreelyTransferable
/// case). Reading the 4 Permissioned extras from `remaining_accounts`
/// handles both modes uniformly: 0 entries when FreelyTransferable, 4
/// entries when Permissioned (validated against `mint_config.mode`).
#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: source ATA — owner read from offset 32..64 of account data.
    /// Index 0 in the canonical TransferHook layout.
    pub source_ata: UncheckedAccount<'info>,

    /// CHECK: mint that's being transferred (validated via mint_config seed).
    /// Index 1.
    pub mint: UncheckedAccount<'info>,

    /// CHECK: destination ATA — owner read from offset 32..64.
    /// Index 2.
    pub destination_ata: UncheckedAccount<'info>,

    /// CHECK: source owner authority (also derivable from `source_ata`).
    /// Index 3.
    pub source_owner: UncheckedAccount<'info>,

    /// CHECK: ExtraAccountMetaList PDA — Token-2022's `invoke_execute`
    /// inserts THIS account at index 4 of the CPI account list (BEFORE
    /// the resolved EAML extras), per `spl-transfer-hook-interface`'s
    /// `onchain::invoke_execute`. Without surfacing it in our Accounts
    /// struct, Anchor would interpret index 4 as the first resolved
    /// extra (mint_config) and fail with `AccountDiscriminatorMismatch`
    /// because the EAML's data does not match the MintConfig shape.
    /// We validate it via the canonical seed constraint
    /// `[b"extra-account-metas", mint]` so a forged value can't be
    /// substituted by a malicious caller.
    /// Index 4.
    #[account(
        seeds = [crate::instructions::initialize_extra_account_meta_list::EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// Per-mint configuration; mode discriminator drives the branch below.
    /// Index 5.
    #[account(
        seeds = [MintConfig::SEED_PREFIX, mint.key().as_ref()],
        bump,
    )]
    pub mint_config: Account<'info, MintConfig>,

    /// Global sanctions list (singleton PDA).
    /// Index 6.
    #[account(
        seeds = [SanctionsList::SEED_PREFIX],
        bump,
    )]
    pub sanctions_list: Account<'info, SanctionsList>,

    /// CHECK: optional `FrozenAccount` PDA for source. Existence indicates
    /// frozen; an absent PDA shows up here as a default-zero account.
    /// Index 7.
    pub source_frozen_check: UncheckedAccount<'info>,

    /// CHECK: optional `FrozenAccount` PDA for destination. Same semantics.
    /// Index 8.
    pub destination_frozen_check: UncheckedAccount<'info>,
    // Permissioned-mode extras are accessed via `ctx.remaining_accounts`:
    //   [0] attestation_program  — fixed pubkey (CPI index 9)
    //   [1] source_attestation   — cross-program PDA (CPI index 10)
    //   [2] destination_attestation — cross-program PDA (CPI index 11)
    //   [3] pool_policy          — fixed pubkey (CPI index 12)
}

/// Read the owner pubkey from a Token-2022 ATA's raw account data.
///
/// Per the SPL Token-2022 account layout, bytes 32..64 hold the `owner`
/// pubkey. We deliberately don't try to deserialize the full TokenAccount
/// struct here — we only need the owner field, and reading raw bytes keeps
/// the hook resilient to extension-bearing accounts whose total size differs
/// from the base account size.
fn ata_owner(ata: &AccountInfo) -> Result<Pubkey> {
    let data = ata.try_borrow_data()?;
    if data.len() < 64 {
        // The interface's `IncorrectAccountSize` variant doesn't exist in the
        // 0.9 release; the closest semantic match is `IncorrectAccount`.
        // Conversion goes through `ProgramError` because Anchor's `Error`
        // implements `From<ProgramError>` but not `From<TransferHookError>`
        // directly.
        return Err(ProgramError::from(TransferHookError::IncorrectAccount).into());
    }
    Ok(Pubkey::try_from(&data[32..64])
        .map_err(|_| -> Error { ProgramError::from(TransferHookError::IncorrectAccount).into() })?)
}

pub fn handler(ctx: Context<Execute>) -> Result<()> {
    let source_owner = ata_owner(&ctx.accounts.source_ata)?;
    let dest_owner = ata_owner(&ctx.accounts.destination_ata)?;

    let sl = &ctx.accounts.sanctions_list;
    require!(
        !sl.contains(&source_owner) && !sl.contains(&dest_owner),
        ComplianceHookError::SanctionedAddress
    );

    // Frozen check: PDA existence — non-zero lamports + non-empty data —
    // marks the account as frozen. The runtime passes the derived PDA
    // address even when the account doesn't exist; in that case
    // lamports == 0 and data.len() == 0, so the booleans below stay
    // false. The `freeze_account` instruction creates the PDA at
    // `[b"frozen", owner]` (gated by `SanctionsList.authority`), and
    // `unfreeze_account` closes it.
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
            // Token-2022 runtime resolves the EAML's 8 Permissioned extras
            // and supplies the trailing 4 (attestation_program,
            // source_attestation, destination_attestation, pool_policy) as
            // `remaining_accounts`. Anchor 0.31's `Option<T>` binding does
            // not silently bind None for absent trailing accounts in the
            // FreelyTransferable case, so we keep the optional extras off
            // the typed struct and read them positionally here. Exactly 4
            // entries are expected — any other count means the EAML was
            // misconfigured (`AttestationNotFound`, 6002, matching the
            // Helius webhook parser's 6000-series convention).
            const PERMISSIONED_REMAINING_COUNT: usize = 4;
            require!(
                ctx.remaining_accounts.len() == PERMISSIONED_REMAINING_COUNT,
                ComplianceHookError::AttestationNotFound
            );
            // Index map (matches the EAML's order):
            //   0 = attestation_program (fixed pubkey, CPI index 9)
            //   1 = source_attestation
            //   2 = destination_attestation
            //   3 = pool_policy (unused — reserved for a future
            //       policy-enforcement layer)
            let attestation_program_acct = &ctx.remaining_accounts[0];
            require_keys_eq!(
                attestation_program_acct.key(),
                ctx.accounts.mint_config.attestation_program,
                ComplianceHookError::InvalidAttestationProgram
            );

            let src_att = &ctx.remaining_accounts[1];
            let dst_att = &ctx.remaining_accounts[2];

            // Full identity-binding validation against the mint's trust
            // anchors. Each call enforces the FIVE checks documented on
            // `check_attestation` below. With these in place, even a
            // manually-supplied Permissioned-mode account list cannot
            // satisfy the hook with a foreign-owner / wrong-subject /
            // wrong-issuer / wrong-type / mis-derived attestation.
            check_attestation(src_att, &source_owner, &ctx.accounts.mint_config, "source")?;
            check_attestation(
                dst_att,
                &dest_owner,
                &ctx.accounts.mint_config,
                "destination",
            )?;

            // Optional policy layer: pool_policy thresholds (jurisdiction /
            // investor_class / kyc_risk_tier) against the loaded attestations.
            // The current handler leaves `pool_policy` wired but unread — the
            // EAML still resolves it so a future upgrade can flip the
            // enforcement on without re-init.
            Ok(())
        }
    }
}

/// Reads an SVS-11-shaped Attestation account (raw, without anchor zero-copy)
/// and validates it against the mint's trust anchors.
///
/// Validation steps (each mapped to a distinct error code so failure mode is
/// observable in logs / parsed events):
///   1. **Owner**: `att.owner == mint_config.attestation_program`.
///   2. **Existence + size**: `lamports > 0`, `data_len >= 129`.
///   3. **Subject**: `payload[0..32] == expected_subject` (the ATA owner).
///   4. **Issuer**: `payload[32..64] == mint_config.attestation_issuer`.
///   5. **Type**: `payload[64] == mint_config.required_attestation_type`.
///   6. **Revoked**: `payload[83] == 0`.
///   7. **Not expired**: `now < payload[75..83]` (i64 LE).
///   8. **Canonical PDA**: `Pubkey::create_program_address(
///         [b"attestation", subject, issuer, attestation_type, bump],
///         mint_config.attestation_program) == att.key()`.
///
/// (8) atomically binds (1)-(5) to the same physical account: a mismatch
/// in subject / issuer / type produces a different PDA, which would fail
/// (8) even if a forged payload could trick (3)-(5) individually.
///
/// Layout is fixed by SVS-11's `Attestation` struct (see
/// `programs/svs-11/src/attestation.rs`). Field offsets — DO NOT desync
/// this from svs-11 state without updating both sides AND the parallel
/// reader in `programs/derwa-wrapper/src/instructions/unwrap.rs`. Current
/// offset map (after the 8-byte Anchor discriminator):
///   0..32    subject (Pubkey)
///   32..64   issuer (Pubkey)
///   64       attestation_type (u8)
///   65..67   country_code ([u8; 2])
///   67..75   issued_at (i64)
///   75..83   expires_at (i64)
///   83       revoked (bool, 1 byte)
///   84       bump (u8)
///   85..117  _reserved ([u8; 32])
///   117..119 jurisdiction ([u8; 2])
///   119      investor_class (u8)
///   120      kyc_risk_tier (u8)
/// Total: 121 bytes after discriminator (LEN = 8 + 121 = 129).
fn check_attestation(
    att: &AccountInfo,
    expected_subject: &Pubkey,
    mint_config: &MintConfig,
    label: &'static str,
) -> Result<()> {
    // (1) Owner = configured attestation program.
    require!(
        att.owner == &mint_config.attestation_program,
        ComplianceHookError::InvalidAttestationProgram
    );

    // (2) Existence + size.
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

    // (3) Subject = expected ATA owner.
    let subject = Pubkey::new_from_array(bytes_at(0..32)?);
    require!(
        &subject == expected_subject,
        ComplianceHookError::InvalidAttestationSubject
    );

    // (4) Issuer = mint-configured issuer.
    let issuer = Pubkey::new_from_array(bytes_at(32..64)?);
    require!(
        issuer == mint_config.attestation_issuer,
        ComplianceHookError::InvalidAttestationIssuer
    );

    // (5) Attestation type = mint-required type.
    let attestation_type = payload[64];
    require!(
        attestation_type == mint_config.required_attestation_type,
        ComplianceHookError::InvalidAttestationType
    );

    // (6) Not revoked.
    let revoked = payload[83] != 0;
    require!(!revoked, ComplianceHookError::AttestationRevoked);

    // (7) Not expired.
    let expires_bytes: [u8; 8] = payload[75..83]
        .try_into()
        .map_err(|_| -> Error { error!(ComplianceHookError::AttestationNotFound) })?;
    let expires_at = i64::from_le_bytes(expires_bytes);
    let now = Clock::get()?.unix_timestamp;
    require!(now < expires_at, ComplianceHookError::AttestationExpired);

    // (8) Canonical PDA derivation under the configured attestation program.
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

    msg!("attestation OK ({})", label);
    Ok(())
}
