/**
 * Resolver for the `transfer_checked` ix `remainingAccounts` slice when
 * transferring a Token-2022 mint with the `compliance-hook` TransferHook.
 *
 * The Token-2022 runtime CPIs into the configured hook program for every
 * `transfer_checked`. The hook needs its `ExtraAccountMetaList` (EAML)
 * extras + the hook program account itself + the EAML PDA in the
 * outer ix's account list, otherwise the runtime cannot satisfy the
 * extras during CPI account resolution. SDK callers building manual
 * `transfer_checked` ix (e.g. CPI calls inside derwa-wrapper or
 * SVS-11's redemption flow) must populate `remainingAccounts` with the
 * resolved layout this helper returns.
 *
 * Layout (matches `spl-token-js`'s `addExtraAccountMetasForExecute` and
 * the on-chain layout in
 * `programs/compliance-hook/src/instructions/initialize_extra_account_meta_list.rs`):
 *
 *   1. Resolved EAML extras (4 for FreelyTransferable, 8 for Permissioned).
 *   2. Hook program account itself.
 *   3. EAML PDA account.
 *
 * FreelyTransferable extras (4): `mint_config`, `sanctions_list`,
 * `source_frozen_check`, `destination_frozen_check`.
 *
 * Permissioned extras (8): the 4 above plus `attestation_program`
 * (fixed pubkey from `MintConfig.attestation_program`),
 * `source_attestation` and `destination_attestation` (cross-program PDAs
 * under `attestation_program`), and `pool_policy` (fixed pubkey from
 * `MintConfig.pool_policy`).
 *
 * Permissioned mode also requires the caller to pass the same
 * `attestationProgram`, `attestationIssuer`, and
 * `requiredAttestationType` that were baked into `MintConfig` at init
 * time, otherwise the cross-program PDA derivation produces a different
 * address than what the runtime resolves and on-chain
 * `check_attestation` rejects with `InvalidAttestationPda`.
 */
import { AccountMeta, PublicKey } from "@solana/web3.js";

import {
  COMPLIANCE_HOOK_PROGRAM_ID,
  getComplianceFrozenAccountAddress,
  getExtraAccountMetaListAddress,
  getMintConfigAddress,
  getSanctionsListAddress,
} from "./compliance-hook-pda";
import { getAttestationAddress } from "./attestation-pda";

/** Args for {@link resolveHookExtras}. */
export interface ResolveHookExtrasArgs {
  /** The compliance-hook program ID (defaults to the deployed one). */
  complianceHookProgramId?: PublicKey;
  /** The Token-2022 mint whose `transfer_checked` is being constructed. */
  mint: PublicKey;
  /** ATA owner of the source token account. */
  sourceOwner: PublicKey;
  /** ATA owner of the destination token account. */
  destinationOwner: PublicKey;
  /** `true` if the mint's `MintConfig.mode == Permissioned`. */
  permissioned: boolean;
  /** Required when `permissioned == true`. */
  attestationProgram?: PublicKey;
  /** Required when `permissioned == true`. */
  attestationIssuer?: PublicKey;
  /** Required when `permissioned == true`. */
  requiredAttestationType?: number;
  /** Required when `permissioned == true`. */
  poolPolicy?: PublicKey;
}

/**
 * Resolve the `AccountMeta[]` slice to append via `.remainingAccounts`
 * when invoking a `transfer_checked` ix that fires the compliance-hook.
 *
 * @throws Error if `permissioned: true` and any of `attestationProgram`,
 * `attestationIssuer`, `requiredAttestationType`, or `poolPolicy` is
 * missing.
 */
export function resolveHookExtras(args: ResolveHookExtrasArgs): AccountMeta[] {
  const programId = args.complianceHookProgramId ?? COMPLIANCE_HOOK_PROGRAM_ID;

  const [mintConfig] = getMintConfigAddress(args.mint, programId);
  const [sanctionsList] = getSanctionsListAddress(programId);
  const [sourceFrozenCheck] = getComplianceFrozenAccountAddress(
    args.sourceOwner,
    programId,
  );
  const [destinationFrozenCheck] = getComplianceFrozenAccountAddress(
    args.destinationOwner,
    programId,
  );

  const metas: AccountMeta[] = [
    { pubkey: mintConfig, isSigner: false, isWritable: false },
    { pubkey: sanctionsList, isSigner: false, isWritable: false },
    { pubkey: sourceFrozenCheck, isSigner: false, isWritable: false },
    { pubkey: destinationFrozenCheck, isSigner: false, isWritable: false },
  ];

  if (args.permissioned) {
    if (
      !args.attestationProgram ||
      !args.attestationIssuer ||
      args.requiredAttestationType === undefined ||
      !args.poolPolicy
    ) {
      throw new Error(
        "resolveHookExtras: permissioned mode requires attestationProgram, attestationIssuer, requiredAttestationType, poolPolicy",
      );
    }

    const [sourceAttestation] = getAttestationAddress(
      args.sourceOwner,
      args.attestationIssuer,
      args.requiredAttestationType,
      args.attestationProgram,
    );
    const [destinationAttestation] = getAttestationAddress(
      args.destinationOwner,
      args.attestationIssuer,
      args.requiredAttestationType,
      args.attestationProgram,
    );

    metas.push(
      { pubkey: args.attestationProgram, isSigner: false, isWritable: false },
      { pubkey: sourceAttestation, isSigner: false, isWritable: false },
      { pubkey: destinationAttestation, isSigner: false, isWritable: false },
      { pubkey: args.poolPolicy, isSigner: false, isWritable: false },
    );
  }

  // Hook program + EAML PDA must be in the outer ix's account list so
  // the Token-2022 runtime can CPI into the hook with its declared
  // extras. Order mirrors spl-token-js's
  // `addExtraAccountMetasForExecute`: extras first, then hook program,
  // then EAML PDA.
  const [extraAccountMetaList] = getExtraAccountMetaListAddress(
    args.mint,
    programId,
  );

  metas.push(
    { pubkey: programId, isSigner: false, isWritable: false },
    { pubkey: extraAccountMetaList, isSigner: false, isWritable: false },
  );

  return metas;
}
