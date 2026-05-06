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
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createInitializeTransferHookInstruction,
  createInitializeMintInstruction,
  getMintLen,
} from "@solana/spl-token";

import {
  getAttestationAddress,
  getExtraAccountMetaListAddress,
  getMintConfigAddress,
} from "../../sdk/core/src";
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
  const [mintConfig] = getMintConfigAddress(mint, complianceHook.programId);

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
  const [eaml] = getExtraAccountMetaListAddress(mint, complianceHook.programId);
  const [mintConfig] = getMintConfigAddress(mint, complianceHook.programId);

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
  const [attestation] = getAttestationAddress(
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

// `resolveHookExtras` and `ResolveHookExtrasArgs` were promoted from
// this test helper to the SDK so production callers (CLI, backend) can
// import them without reaching into test scaffolding. Import from
// `../../sdk/core/src` (or `@stbr/solana-vault` once consumed as a
// package) instead.
