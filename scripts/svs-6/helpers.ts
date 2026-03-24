/**
 * SVS-6 helpers — re-exports shared utilities with SVS-6 types.
 * SVS-6 = Confidential Streaming Yield (SVS-5 streaming + SVS-3 confidential).
 * Uses "confidential_stream_vault" seed for the vault PDA.
 */

import { Program, BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { Svs6 } from "../../target/types/svs_6";
import {
  setupTest as genericSetupTest,
  type SetupResult as GenericSetupResult,
} from "../shared/common-helpers";
import {
  requireBackend,
  requestPubkeyValidityProof,
  requestWithdrawProof,
  readAvailableBalanceCiphertext,
  deriveAesKeyFromSignature,
  createDecryptableZeroBalance,
  createDecryptableBalance,
  createProofContext,
  ZK_ELGAMAL_PROOF_PROGRAM_ID,
  EQUALITY_CONTEXT_SIZE,
  RANGE_CONTEXT_SIZE,
} from "../shared/proof-helpers";

// Re-export shared utilities (except getVaultPDA which we override)
export {
  RPC_URL,
  ASSET_DECIMALS,
  SHARE_DECIMALS,
  loadKeypair,
  getSharesMintPDA,
  explorerUrl,
  accountUrl,
  fundAccount,
  fundAccounts,
} from "../shared/common-helpers";

// Re-export proof helpers
export {
  requireBackend,
  requestPubkeyValidityProof,
  requestWithdrawProof,
  readAvailableBalanceCiphertext,
  deriveAesKeyFromSignature,
  createDecryptableZeroBalance,
  createDecryptableBalance,
  createProofContext,
  ZK_ELGAMAL_PROOF_PROGRAM_ID,
  EQUALITY_CONTEXT_SIZE,
  RANGE_CONTEXT_SIZE,
};

/** SVS-6 vault PDA uses "confidential_stream_vault" seed */
export function getVaultPDA(programId: PublicKey, assetMint: PublicKey, vaultId: BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("confidential_stream_vault"), assetMint.toBuffer(), vaultId.toArrayLike(Buffer, "le", 8)],
    programId
  );
}

export interface SetupResult {
  connection: Connection;
  payer: Keypair;
  provider: anchor.AnchorProvider;
  program: Program<Svs6>;
  programId: PublicKey;
}

export async function setupTest(testName: string): Promise<SetupResult> {
  return genericSetupTest<Svs6>(testName, "svs_6");
}

/** Create ATA for shares token (idempotent — safe to call if ATA already exists) */
export function createSharesAtaIx(
  payer: PublicKey,
  owner: PublicKey,
  sharesMint: PublicKey,
): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(
    payer,
    getSharesAtaAddress(owner, sharesMint),
    owner,
    sharesMint,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

/** Derive the shares ATA address for a given owner */
function getSharesAtaAddress(owner: PublicKey, sharesMint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(sharesMint, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

// ---------------------------------------------------------------------------
// Streaming helpers
// ---------------------------------------------------------------------------

/** Distribute yield as a time-interpolated stream (authority only) */
export async function distributeYield(
  program: Program<Svs6>,
  authority: Keypair,
  vault: PublicKey,
  assetMint: PublicKey,
  authorityAssetAccount: PublicKey,
  assetVault: PublicKey,
  yieldAmount: BN,
  duration: BN,
): Promise<string> {
  return program.methods
    .distributeYield(yieldAmount, duration)
    .accountsStrict({
      authority: authority.publicKey,
      vault,
      assetMint,
      authorityAssetAccount,
      assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}

/** Checkpoint: materialize accrued streaming yield (permissionless) */
export async function checkpoint(
  program: Program<Svs6>,
  vault: PublicKey,
): Promise<string> {
  return program.methods
    .checkpoint()
    .accountsStrict({ vault })
    .rpc();
}

// ---------------------------------------------------------------------------
// Confidential transfer helpers
// ---------------------------------------------------------------------------

/**
 * Configure a user's shares account for confidential transfers.
 * Sends verify proof + configure_account in a single transaction.
 */
export async function configureUserAccount(
  provider: anchor.AnchorProvider,
  program: Program<Svs6>,
  user: Keypair,
  vault: PublicKey,
  sharesMint: PublicKey,
  userSharesAccount: PublicKey,
): Promise<string> {
  await getOrCreateAssociatedTokenAccount(
    provider.connection, user, sharesMint, user.publicKey, false,
    undefined, undefined, TOKEN_2022_PROGRAM_ID
  );

  const { proofData } = await requestPubkeyValidityProof(user, userSharesAccount);
  const aesKey = deriveAesKeyFromSignature(user, userSharesAccount);
  const decryptableZeroBalance = createDecryptableZeroBalance(aesKey);

  const verifyProofIx = new TransactionInstruction({
    programId: ZK_ELGAMAL_PROOF_PROGRAM_ID,
    keys: [],
    data: Buffer.concat([Buffer.from([4]), proofData]),
  });

  const configureIx = await program.methods
    .configureAccount(Array.from(decryptableZeroBalance), -1)
    .accountsStrict({
      user: user.publicKey,
      vault,
      sharesMint,
      userSharesAccount,
      proofContextAccount: null,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const tx = new Transaction().add(verifyProofIx, configureIx);
  return provider.sendAndConfirm(tx, user === (provider.wallet as anchor.Wallet).payer ? [] : [user]);
}

/**
 * Redeem shares with ZK proofs (confidential flow).
 */
export async function redeemConfidential(
  provider: anchor.AnchorProvider,
  program: Program<Svs6>,
  user: Keypair,
  vault: PublicKey,
  assetMint: PublicKey,
  userAssetAccount: PublicKey,
  assetVault: PublicKey,
  sharesMint: PublicKey,
  userSharesAccount: PublicKey,
  sharesToRedeem: number,
  currentBalance: number,
): Promise<string> {
  const connection = provider.connection;
  const availableCiphertext = await readAvailableBalanceCiphertext(connection, userSharesAccount);
  const { equalityProof, rangeProof } = await requestWithdrawProof(
    user, userSharesAccount, availableCiphertext, currentBalance, sharesToRedeem
  );

  const EQUALITY_PROOF_TYPE = 3;  // CiphertextCommitmentEquality
  const RANGE_PROOF_TYPE = 6;    // BatchedRangeProofU64
  const equalityContext = await createProofContext(provider, user, EQUALITY_PROOF_TYPE, equalityProof, EQUALITY_CONTEXT_SIZE);
  const rangeContext = await createProofContext(provider, user, RANGE_PROOF_TYPE, rangeProof, RANGE_CONTEXT_SIZE);

  const remainingShares = currentBalance - sharesToRedeem;
  const aesKey = deriveAesKeyFromSignature(user, userSharesAccount);
  const newDecryptableBalance = createDecryptableBalance(aesKey, remainingShares);

  return program.methods
    .redeem(new BN(sharesToRedeem), new BN(0), Array.from(newDecryptableBalance))
    .accountsStrict({
      user: user.publicKey, vault, assetMint, userAssetAccount, assetVault,
      sharesMint, userSharesAccount,
      equalityProofContext: equalityContext,
      rangeProofContext: rangeContext,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .signers(user === (provider.wallet as anchor.Wallet).payer ? [] : [user])
    .rpc();
}

/**
 * Withdraw exact assets with ZK proofs (confidential flow).
 */
export async function withdrawConfidential(
  provider: anchor.AnchorProvider,
  program: Program<Svs6>,
  user: Keypair,
  vault: PublicKey,
  assetMint: PublicKey,
  userAssetAccount: PublicKey,
  assetVault: PublicKey,
  sharesMint: PublicKey,
  userSharesAccount: PublicKey,
  assetsToWithdraw: number,
  sharesToBurn: number,
  currentBalance: number,
): Promise<string> {
  const connection = provider.connection;
  const availableCiphertext = await readAvailableBalanceCiphertext(connection, userSharesAccount);
  const { equalityProof, rangeProof } = await requestWithdrawProof(
    user, userSharesAccount, availableCiphertext, currentBalance, sharesToBurn
  );

  const EQUALITY_PROOF_TYPE = 3;  // CiphertextCommitmentEquality
  const RANGE_PROOF_TYPE = 6;    // BatchedRangeProofU64
  const equalityContext = await createProofContext(provider, user, EQUALITY_PROOF_TYPE, equalityProof, EQUALITY_CONTEXT_SIZE);
  const rangeContext = await createProofContext(provider, user, RANGE_PROOF_TYPE, rangeProof, RANGE_CONTEXT_SIZE);

  const remainingShares = currentBalance - sharesToBurn;
  const aesKey = deriveAesKeyFromSignature(user, userSharesAccount);
  const newDecryptableBalance = createDecryptableBalance(aesKey, remainingShares);

  return program.methods
    .withdraw(new BN(assetsToWithdraw), new BN(Math.ceil(sharesToBurn * 1.05)), Array.from(newDecryptableBalance))
    .accountsStrict({
      user: user.publicKey, vault, assetMint, userAssetAccount, assetVault,
      sharesMint, userSharesAccount,
      equalityProofContext: equalityContext,
      rangeProofContext: rangeContext,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .signers(user === (provider.wallet as anchor.Wallet).payer ? [] : [user])
    .rpc();
}
