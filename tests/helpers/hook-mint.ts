/**
 * Helpers for spinning up Token-2022 mints with the compliance-hook
 * `TransferHook` extension and initializing the per-mint MintConfig +
 * ExtraAccountMetaList. Used by `compliance-hook.spec.ts` and
 * `derwa-wrapper.spec.ts` to prove the hook is wired end-to-end against
 * a real mint instead of stubbing the runtime.
 *
 * The shape mirrors the operator deploy flow in
 * `scripts/create-derwa-mint.ts`, condensed for in-test usage:
 *
 *   1. Allocate the mint account sized for `[ExtensionType.TransferHook]`.
 *   2. `createInitializeTransferHookInstruction` (must run BEFORE base
 *      mint init — Token-2022 rejects extension config after the base
 *      `InitializeMint` lands).
 *   3. `createInitializeMintInstruction` for the base mint.
 *   4. Send tx (signed by payer + the new mint keypair).
 *   5. `compliance_hook.initialize_mint_config` to bind the per-mint
 *      compliance posture (FreelyTransferable | Permissioned + trust
 *      anchors).
 *   6. `compliance_hook.initialize_extra_account_meta_list` to populate
 *      the EAML PDA the runtime reads when invoking the hook.
 *
 * The Permissioned EAML extras (8 entries — see
 * `programs/compliance-hook/src/instructions/initialize_extra_account_meta_list.rs`)
 * include cross-program PDAs derived under the configured attestation
 * program, so the resolver helper at the bottom returns the resolved
 * `AccountMeta[]` callers must pass via `remainingAccounts` when invoking
 * a `transfer_checked` CPI inside another program (e.g. derwa-wrapper's
 * `wrap` / `unwrap`).
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Signer,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  AccountMeta,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createInitializeTransferHookInstruction,
  createInitializeMintInstruction,
  getMintLen,
} from "@solana/spl-token";

import type { ComplianceHook } from "../../target/types/compliance_hook";
import type { MockSas } from "../../target/types/mock_sas";

/** Compliance modes — matches IDL enum tag shape. */
export type ComplianceModeArg =
  | { freelyTransferable: Record<string, never> }
  | { permissioned: Record<string, never> };

export const ComplianceModeArg = {
  freelyTransferable: (): ComplianceModeArg => ({ freelyTransferable: {} }),
  permissioned: (): ComplianceModeArg => ({ permissioned: {} }),
};

/**
 * Create a Token-2022 mint with the `TransferHook` extension bound to the
 * given compliance-hook program ID. Returns the mint pubkey; the caller
 * keeps the keypair for funding/transfer-out ATAs as needed.
 *
 * Authority defaults to the payer; pass `mintAuthority` if a different
 * key should hold the post-init authority. The TransferHook extension
 * authority (controls hook-program rotation) is the same as
 * `mintAuthority`.
 */
export async function createHookBoundMint(
  connection: Connection,
  payer: Signer,
  mintAuthority: PublicKey,
  complianceHookProgramId: PublicKey,
  decimals: number,
): Promise<{ mint: PublicKey; mintKp: Keypair }> {
  const mintKp = Keypair.generate();
  const mintLen = getMintLen([ExtensionType.TransferHook]);
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mintKp.publicKey,
      lamports,
      space: mintLen,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeTransferHookInstruction(
      mintKp.publicKey,
      mintAuthority, // extension authority
      complianceHookProgramId,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMintInstruction(
      mintKp.publicKey,
      decimals,
      mintAuthority, // mint authority
      null, // freeze authority — none for our test mints
      TOKEN_2022_PROGRAM_ID,
    ),
  );

  await sendAndConfirmTransaction(connection, tx, [payer, mintKp]);

  return { mint: mintKp.publicKey, mintKp };
}

/**
 * Build the `[b"mint_config", mint]` PDA under compliance-hook.
 */
export function getMintConfigPda(
  mint: PublicKey,
  complianceHookProgramId: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_config"), mint.toBuffer()],
    complianceHookProgramId,
  );
  return pda;
}

/**
 * Build the `[b"extra-account-metas", mint]` PDA — the canonical Token-2022
 * TransferHook spec literal (HYPHEN, not underscore — the Token-2022
 * runtime looks up exactly this byte string).
 */
export function getEamlPda(
  mint: PublicKey,
  complianceHookProgramId: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()],
    complianceHookProgramId,
  );
  return pda;
}

/**
 * Build the `[b"sanctions_list"]` singleton PDA under compliance-hook.
 */
export function getSanctionsListPda(complianceHookProgramId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("sanctions_list")],
    complianceHookProgramId,
  );
  return pda;
}

/**
 * Build the `[b"frozen", owner]` per-wallet freeze marker PDA under
 * compliance-hook.
 */
export function getFrozenAccountPda(
  owner: PublicKey,
  complianceHookProgramId: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("frozen"), owner.toBuffer()],
    complianceHookProgramId,
  );
  return pda;
}

/**
 * Build the canonical SVS-11 attestation PDA under a given attestation
 * program. Seeds: `[b"attestation", subject, issuer, attestation_type]`.
 *
 * MUST stay in lockstep with mock-sas's `create_attestation` and the
 * EAML's cross-program PDA derivation in compliance-hook. A mismatch
 * here breaks the on-chain `check_attestation` PDA-canonical check.
 */
export function getAttestationPda(
  subject: PublicKey,
  issuer: PublicKey,
  attestationType: number,
  attestationProgramId: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("attestation"),
      subject.toBuffer(),
      issuer.toBuffer(),
      Buffer.from([attestationType]),
    ],
    attestationProgramId,
  );
  return pda;
}

/**
 * Wrap `compliance_hook.initialize_mint_config`. Pass either
 * FreelyTransferable args (no trust anchors needed; defaults are stored
 * but unused) or Permissioned args (trust anchors required, on-chain
 * handler rejects defaults).
 */
export interface InitMintConfigArgs {
  mode: ComplianceModeArg;
  poolPolicy?: PublicKey | null;
  attestationProgram?: PublicKey;
  attestationIssuer?: PublicKey;
  requiredAttestationType?: number;
}

export async function initMintConfig(
  complianceHook: Program<ComplianceHook>,
  mint: PublicKey,
  mintAuthority: Signer,
  payer: Signer,
  args: InitMintConfigArgs,
): Promise<PublicKey> {
  const mintConfig = getMintConfigPda(mint, complianceHook.programId);

  await complianceHook.methods
    .initializeMintConfig({
      mode: args.mode,
      poolPolicy: args.poolPolicy ?? null,
      attestationProgram: args.attestationProgram ?? PublicKey.default,
      attestationIssuer: args.attestationIssuer ?? PublicKey.default,
      requiredAttestationType: args.requiredAttestationType ?? 0,
    })
    .accountsPartial({
      mintConfig,
      mint,
      mintAuthority: mintAuthority.publicKey,
      payer: payer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([mintAuthority, payer].filter((s, i, a) => a.indexOf(s) === i))
    .rpc();

  return mintConfig;
}

/**
 * Wrap `compliance_hook.initialize_extra_account_meta_list`. Must be
 * called AFTER `initMintConfig` for the same mint.
 */
export async function initEaml(
  complianceHook: Program<ComplianceHook>,
  mint: PublicKey,
  mintAuthority: Signer,
  payer: Signer,
): Promise<PublicKey> {
  const eaml = getEamlPda(mint, complianceHook.programId);
  const mintConfig = getMintConfigPda(mint, complianceHook.programId);

  await complianceHook.methods
    .initializeExtraAccountMetaList()
    .accountsPartial({
      extraAccountMetaList: eaml,
      mint,
      mintConfig,
      mintAuthority: mintAuthority.publicKey,
      payer: payer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([mintAuthority, payer].filter((s, i, a) => a.indexOf(s) === i))
    .rpc();

  return eaml;
}

/**
 * Issue an SVS-11-shaped attestation via the mock-sas program. Returns
 * the attestation PDA. The mock-sas program lets any signer (here the
 * payer) create attestations for any subject — a constraint that real
 * SAS / Civic Pass implementations would gate behind their own KYB
 * verification flow. For test purposes this lets us mint attestations
 * for arbitrary subjects (including PDAs like the wrapper signer).
 */
export async function createSvsAttestation(
  mockSas: Program<MockSas>,
  payer: Signer,
  subject: PublicKey,
  issuer: PublicKey,
  attestationType: number,
  countryCode: [number, number],
  expiresAt: BN,
): Promise<PublicKey> {
  const attestation = getAttestationPda(
    subject,
    issuer,
    attestationType,
    mockSas.programId,
  );

  await mockSas.methods
    .createAttestation(issuer, attestationType, countryCode, expiresAt)
    .accountsPartial({
      authority: payer.publicKey,
      attestation,
      subject,
      systemProgram: SystemProgram.programId,
    })
    .signers([payer])
    .rpc();

  return attestation;
}

/**
 * Resolve the EAML extras for a `transfer_checked` ix on a hook-bound
 * mint, given the canonical `(source_owner, destination_owner)`. Returns
 * the `AccountMeta[]` slice callers must append via `.remainingAccounts`
 * (top-level transfers) or `.remainingAccounts(...)` on a wrapper-program
 * builder (CPI transfers).
 *
 * Layout (matches spl-token-js's `addExtraAccountMetasForExecute`):
 *
 *   1. Resolved EAML extras (4 for FreelyTransferable, 8 for Permissioned).
 *   2. Hook program account itself — Token-2022 needs this in the account
 *      list to CPI into the hook.
 *   3. EAML PDA account — Token-2022 reads this to look up the resolved
 *      extras layout (already encoded in the EAML's data).
 *
 * The EAML index map MUST stay in sync with
 * `programs/compliance-hook/src/instructions/initialize_extra_account_meta_list.rs`:
 *
 *   FreelyTransferable (4 extras): mint_config, sanctions_list,
 *   source_frozen_check, destination_frozen_check.
 *
 *   Permissioned (8 extras): the 4 above plus attestation_program (fixed
 *   pubkey from MintConfig.attestation_program), source_attestation
 *   (cross-program PDA under attestation_program), destination_attestation
 *   (same), pool_policy (fixed pubkey from MintConfig.pool_policy).
 *
 * Caller must pass the same `attestationProgram`, `attestationIssuer`,
 * and `requiredAttestationType` that were baked into MintConfig at init
 * time, otherwise the cross-program PDA derivation produces a different
 * address than what the runtime resolves and on-chain `check_attestation`
 * will read a wrong-PDA failure.
 */
export interface ResolveHookExtrasArgs {
  complianceHookProgramId: PublicKey;
  mint: PublicKey;
  sourceOwner: PublicKey;
  destinationOwner: PublicKey;
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

export function resolveHookExtras(args: ResolveHookExtrasArgs): AccountMeta[] {
  const metas: AccountMeta[] = [
    {
      pubkey: getMintConfigPda(args.mint, args.complianceHookProgramId),
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: getSanctionsListPda(args.complianceHookProgramId),
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: getFrozenAccountPda(args.sourceOwner, args.complianceHookProgramId),
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: getFrozenAccountPda(
        args.destinationOwner,
        args.complianceHookProgramId,
      ),
      isSigner: false,
      isWritable: false,
    },
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
    metas.push(
      // attestation_program — fixed pubkey baked into EAML at init time.
      {
        pubkey: args.attestationProgram,
        isSigner: false,
        isWritable: false,
      },
      // source_attestation — cross-program PDA under attestation_program.
      {
        pubkey: getAttestationPda(
          args.sourceOwner,
          args.attestationIssuer,
          args.requiredAttestationType,
          args.attestationProgram,
        ),
        isSigner: false,
        isWritable: false,
      },
      // destination_attestation — same shape.
      {
        pubkey: getAttestationPda(
          args.destinationOwner,
          args.attestationIssuer,
          args.requiredAttestationType,
          args.attestationProgram,
        ),
        isSigner: false,
        isWritable: false,
      },
      // pool_policy — fixed pubkey baked into EAML.
      {
        pubkey: args.poolPolicy,
        isSigner: false,
        isWritable: false,
      },
    );
  }

  // Token-2022 requires the hook program account AND the EAML PDA to be
  // in the instruction's account list so the runtime can CPI into the
  // hook with its declared extras. Order mirrors spl-token-js's
  // `addExtraAccountMetasForExecute` (extras first, then hook program,
  // then EAML PDA).
  metas.push({
    pubkey: args.complianceHookProgramId,
    isSigner: false,
    isWritable: false,
  });
  metas.push({
    pubkey: getEamlPda(args.mint, args.complianceHookProgramId),
    isSigner: false,
    isWritable: false,
  });

  return metas;
}
