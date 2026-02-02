/**
 * Confidential Transfer Instructions for Token-2022
 *
 * Manual instruction builders for confidential transfer operations
 * since @solana/spl-token doesn't include these yet.
 *
 * Based on the SPL Token-2022 program specification.
 */

import {
  PublicKey,
  TransactionInstruction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";

/**
 * Confidential Transfer extension instruction discriminator
 * From TokenInstruction enum in SPL Token-2022
 */
const CONFIDENTIAL_TRANSFER_INSTRUCTION = 27;

/**
 * ConfidentialTransferInstruction enum values
 */
enum ConfidentialTransferInstructionType {
  InitializeMint = 0,
  UpdateMint = 1,
  ConfigureAccount = 2,
  ApproveAccount = 3,
  EmptyAccount = 4,
  Deposit = 5,
  Withdraw = 6,
  Transfer = 7,
  ApplyPendingBalance = 8,
  EnableConfidentialCredits = 9,
  DisableConfidentialCredits = 10,
  EnableNonConfidentialCredits = 11,
  DisableNonConfidentialCredits = 12,
}

/**
 * Create a ConfigureAccount instruction
 *
 * Configures a token account for confidential transfers.
 *
 * @param tokenAccount - The token account to configure
 * @param mint - The token mint
 * @param owner - The token account owner
 * @param elgamalPubkey - The user's ElGamal public key (32 bytes)
 * @param decryptableZeroBalance - AES-encrypted zero balance (36 bytes)
 * @param maximumPendingBalanceCreditCounter - Max credits before apply required
 * @param proofInstructionOffset - Offset to the proof instruction (typically 0 for same-tx)
 * @returns TransactionInstruction
 */
export function createConfigureAccountInstruction(
  tokenAccount: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
  elgamalPubkey: Uint8Array,
  decryptableZeroBalance: Uint8Array,
  maximumPendingBalanceCreditCounter: BN = new BN(65536),
  proofInstructionOffset: number = 0,
): TransactionInstruction {
  // Instruction data layout:
  // [0]     - Token instruction discriminator (27 = ConfidentialTransferExtension)
  // [1]     - ConfidentialTransfer instruction type (2 = ConfigureAccount)
  // [2..34] - ElGamal pubkey (32 bytes)
  // [34..70] - Decryptable zero balance (36 bytes)
  // [70..78] - Maximum pending balance credit counter (u64 LE)
  // [78]    - Proof location type (0 = InstructionOffset)
  // [79..80] - Proof instruction offset (i8)
  const data = Buffer.alloc(80);
  let offset = 0;

  // Token instruction discriminator
  data.writeUInt8(CONFIDENTIAL_TRANSFER_INSTRUCTION, offset);
  offset += 1;

  // ConfidentialTransfer instruction type
  data.writeUInt8(ConfidentialTransferInstructionType.ConfigureAccount, offset);
  offset += 1;

  // ElGamal pubkey
  Buffer.from(elgamalPubkey).copy(data, offset);
  offset += 32;

  // Decryptable zero balance
  Buffer.from(decryptableZeroBalance).copy(data, offset);
  offset += 36;

  // Maximum pending balance credit counter
  data.writeBigUInt64LE(
    BigInt(maximumPendingBalanceCreditCounter.toString()),
    offset,
  );
  offset += 8;

  // Proof location: InstructionOffset
  data.writeUInt8(0, offset);
  offset += 1;

  // Proof instruction offset
  data.writeInt8(proofInstructionOffset, offset);

  return new TransactionInstruction({
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_2022_PROGRAM_ID,
    data,
  });
}

/**
 * Create an ApplyPendingBalance instruction
 *
 * Applies the pending balance to the available balance.
 *
 * @param tokenAccount - The token account
 * @param owner - The token account owner
 * @param newDecryptableAvailableBalance - New AES-encrypted available balance (36 bytes)
 * @param expectedPendingBalanceCreditCounter - Expected pending balance credit counter
 * @returns TransactionInstruction
 */
export function createApplyPendingBalanceInstruction(
  tokenAccount: PublicKey,
  owner: PublicKey,
  newDecryptableAvailableBalance: Uint8Array,
  expectedPendingBalanceCreditCounter: BN,
): TransactionInstruction {
  // Instruction data layout:
  // [0]     - Token instruction discriminator (27)
  // [1]     - ConfidentialTransfer instruction type (8 = ApplyPendingBalance)
  // [2..10] - Expected pending balance credit counter (u64 LE)
  // [10..46] - New decryptable available balance (36 bytes)
  const data = Buffer.alloc(46);
  let offset = 0;

  // Token instruction discriminator
  data.writeUInt8(CONFIDENTIAL_TRANSFER_INSTRUCTION, offset);
  offset += 1;

  // ConfidentialTransfer instruction type
  data.writeUInt8(
    ConfidentialTransferInstructionType.ApplyPendingBalance,
    offset,
  );
  offset += 1;

  // Expected pending balance credit counter
  data.writeBigUInt64LE(
    BigInt(expectedPendingBalanceCreditCounter.toString()),
    offset,
  );
  offset += 8;

  // New decryptable available balance
  Buffer.from(newDecryptableAvailableBalance).copy(data, offset);

  return new TransactionInstruction({
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_2022_PROGRAM_ID,
    data,
  });
}

/**
 * Create a Deposit instruction (confidential)
 *
 * Deposits non-confidential tokens into the confidential pending balance.
 *
 * @param tokenAccount - The token account
 * @param mint - The token mint
 * @param amount - Amount to deposit
 * @param decimals - Token decimals
 * @param owner - The token account owner
 * @returns TransactionInstruction
 */
export function createConfidentialDepositInstruction(
  tokenAccount: PublicKey,
  mint: PublicKey,
  amount: BN,
  decimals: number,
  owner: PublicKey,
): TransactionInstruction {
  // Instruction data layout:
  // [0]     - Token instruction discriminator (27)
  // [1]     - ConfidentialTransfer instruction type (5 = Deposit)
  // [2..10] - Amount (u64 LE)
  // [10]    - Decimals
  const data = Buffer.alloc(11);
  let offset = 0;

  // Token instruction discriminator
  data.writeUInt8(CONFIDENTIAL_TRANSFER_INSTRUCTION, offset);
  offset += 1;

  // ConfidentialTransfer instruction type
  data.writeUInt8(ConfidentialTransferInstructionType.Deposit, offset);
  offset += 1;

  // Amount
  data.writeBigUInt64LE(BigInt(amount.toString()), offset);
  offset += 8;

  // Decimals
  data.writeUInt8(decimals, offset);

  return new TransactionInstruction({
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_2022_PROGRAM_ID,
    data,
  });
}

/**
 * Create a Withdraw instruction (confidential)
 *
 * Withdraws tokens from the confidential available balance to non-confidential.
 *
 * @param tokenAccount - The token account
 * @param mint - The token mint
 * @param amount - Amount to withdraw
 * @param decimals - Token decimals
 * @param newDecryptableAvailableBalance - New AES-encrypted available balance (36 bytes)
 * @param owner - The token account owner
 * @param equalityProofInstructionOffset - Offset to equality proof instruction
 * @param rangeProofInstructionOffset - Offset to range proof instruction
 * @returns TransactionInstruction
 */
export function createConfidentialWithdrawInstruction(
  tokenAccount: PublicKey,
  mint: PublicKey,
  amount: BN,
  decimals: number,
  newDecryptableAvailableBalance: Uint8Array,
  owner: PublicKey,
  equalityProofInstructionOffset: number = 0,
  rangeProofInstructionOffset: number = 0,
): TransactionInstruction {
  // Instruction data layout:
  // [0]     - Token instruction discriminator (27)
  // [1]     - ConfidentialTransfer instruction type (6 = Withdraw)
  // [2..10] - Amount (u64 LE)
  // [10]    - Decimals
  // [11..47] - New decryptable available balance (36 bytes)
  // [47]    - Equality proof location type (0 = InstructionOffset)
  // [48]    - Equality proof instruction offset (i8)
  // [49]    - Range proof location type (0 = InstructionOffset)
  // [50]    - Range proof instruction offset (i8)
  const data = Buffer.alloc(51);
  let offset = 0;

  // Token instruction discriminator
  data.writeUInt8(CONFIDENTIAL_TRANSFER_INSTRUCTION, offset);
  offset += 1;

  // ConfidentialTransfer instruction type
  data.writeUInt8(ConfidentialTransferInstructionType.Withdraw, offset);
  offset += 1;

  // Amount
  data.writeBigUInt64LE(BigInt(amount.toString()), offset);
  offset += 8;

  // Decimals
  data.writeUInt8(decimals, offset);
  offset += 1;

  // New decryptable available balance
  Buffer.from(newDecryptableAvailableBalance).copy(data, offset);
  offset += 36;

  // Equality proof location: InstructionOffset
  data.writeUInt8(0, offset);
  offset += 1;

  // Equality proof instruction offset
  data.writeInt8(equalityProofInstructionOffset, offset);
  offset += 1;

  // Range proof location: InstructionOffset
  data.writeUInt8(0, offset);
  offset += 1;

  // Range proof instruction offset
  data.writeInt8(rangeProofInstructionOffset, offset);

  return new TransactionInstruction({
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_2022_PROGRAM_ID,
    data,
  });
}

/**
 * Create an EnableConfidentialCredits instruction
 *
 * Enables the account to receive confidential credits.
 *
 * @param tokenAccount - The token account
 * @param owner - The token account owner
 * @returns TransactionInstruction
 */
export function createEnableConfidentialCreditsInstruction(
  tokenAccount: PublicKey,
  owner: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(2);
  data.writeUInt8(CONFIDENTIAL_TRANSFER_INSTRUCTION, 0);
  data.writeUInt8(
    ConfidentialTransferInstructionType.EnableConfidentialCredits,
    1,
  );

  return new TransactionInstruction({
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_2022_PROGRAM_ID,
    data,
  });
}

/**
 * Create an EnableNonConfidentialCredits instruction
 *
 * Enables the account to receive non-confidential credits.
 *
 * @param tokenAccount - The token account
 * @param owner - The token account owner
 * @returns TransactionInstruction
 */
export function createEnableNonConfidentialCreditsInstruction(
  tokenAccount: PublicKey,
  owner: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(2);
  data.writeUInt8(CONFIDENTIAL_TRANSFER_INSTRUCTION, 0);
  data.writeUInt8(
    ConfidentialTransferInstructionType.EnableNonConfidentialCredits,
    1,
  );

  return new TransactionInstruction({
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_2022_PROGRAM_ID,
    data,
  });
}
