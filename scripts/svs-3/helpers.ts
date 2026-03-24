/**
 * SVS-3 helpers — confidential live balance model.
 */

import { Program, BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { Svs3 } from "../../target/types/svs_3";
import { setupTest as genericSetupTest } from "../shared/common-helpers";
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

export {
  RPC_URL,
  ASSET_DECIMALS,
  SHARE_DECIMALS,
  loadKeypair,
  getVaultPDA,
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

export interface SetupResult {
  connection: Connection;
  payer: Keypair;
  provider: anchor.AnchorProvider;
  program: Program<Svs3>;
  programId: PublicKey;
}

export async function setupTest(testName: string): Promise<SetupResult> {
  return genericSetupTest<Svs3>(testName, "svs_3");
}

/**
 * Configure a user's shares account for confidential transfers.
 * Sends verify proof + configure_account in a single transaction.
 */
export async function configureUserAccount(
  provider: anchor.AnchorProvider,
  program: Program<Svs3>,
  user: Keypair,
  vault: PublicKey,
  sharesMint: PublicKey,
  userSharesAccount: PublicKey,
): Promise<string> {
  // Ensure the shares ATA exists before configuring CT
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
  program: Program<Svs3>,
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

  const equalityContext = await createProofContext(provider, user, 3, equalityProof, EQUALITY_CONTEXT_SIZE);
  const rangeContext = await createProofContext(provider, user, 6, rangeProof, RANGE_CONTEXT_SIZE);

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
      assetTokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
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
  program: Program<Svs3>,
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

  const equalityContext = await createProofContext(provider, user, 3, equalityProof, EQUALITY_CONTEXT_SIZE);
  const rangeContext = await createProofContext(provider, user, 6, rangeProof, RANGE_CONTEXT_SIZE);

  const remainingShares = currentBalance - sharesToBurn;
  const aesKey = deriveAesKeyFromSignature(user, userSharesAccount);
  const newDecryptableBalance = createDecryptableBalance(aesKey, remainingShares);

  return program.methods
    .withdraw(new BN(assetsToWithdraw), new BN(sharesToBurn + 1000), Array.from(newDecryptableBalance))
    .accountsStrict({
      user: user.publicKey, vault, assetMint, userAssetAccount, assetVault,
      sharesMint, userSharesAccount,
      equalityProofContext: equalityContext,
      rangeProofContext: rangeContext,
      assetTokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .signers(user === (provider.wallet as anchor.Wallet).payer ? [] : [user])
    .rpc();
}
