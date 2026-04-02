/**
 * Transaction Utilities
 *
 * Provides simulation-before-send pattern for Anchor transactions.
 * Simulates transactions to detect errors early and optimize compute units.
 */

import { AnchorProvider } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Transaction,
  TransactionInstruction,
  Connection,
  Signer,
} from "@solana/web3.js";

/** CU buffer multiplier applied to simulation result (20% overhead) */
const CU_BUFFER_MULTIPLIER = 1.2;

/**
 * Simulate a transaction and return the compute units consumed.
 *
 * @param connection - Solana RPC connection
 * @param transaction - Transaction to simulate
 * @returns Compute units consumed, or null if simulation didn't report CU
 * @throws Error if simulation fails with an error
 */
export async function simulateTransaction(
  connection: Connection,
  transaction: Transaction,
): Promise<number | null> {
  const simulation = await connection.simulateTransaction(transaction);

  if (simulation.value.err) {
    const logs = simulation.value.logs?.join("\n") ?? "No logs available";
    throw new Error(
      `Transaction simulation failed: ${JSON.stringify(simulation.value.err)}\nLogs:\n${logs}`,
    );
  }

  return simulation.value.unitsConsumed ?? null;
}

/**
 * Build, simulate, optimize CU budget, and send a transaction.
 *
 * Uses Anchor's MethodsBuilder `.transaction()` output, simulates it,
 * prepends a SetComputeUnitLimit instruction based on simulation results
 * (with a 20% buffer), then signs and sends.
 *
 * @param provider - Anchor provider with wallet and connection
 * @param transaction - Built transaction (from `.transaction()`)
 * @param signers - Additional signers beyond the wallet
 * @returns Transaction signature
 */
export async function simulateAndSendTransaction(
  provider: AnchorProvider,
  transaction: Transaction,
  signers: Signer[] = [],
): Promise<string> {
  const connection = provider.connection;

  // Set a recent blockhash for simulation
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = provider.wallet.publicKey;

  // Simulate to detect errors and measure CU
  const unitsConsumed = await simulateTransaction(connection, transaction);

  // Prepend compute budget instruction if simulation reported CU usage
  if (unitsConsumed !== null && unitsConsumed > 0) {
    const cuLimit = Math.ceil(unitsConsumed * CU_BUFFER_MULTIPLIER);
    const cuInstruction = ComputeBudgetProgram.setComputeUnitLimit({
      units: cuLimit,
    });

    // Prepend CU instruction at the front
    transaction.instructions = [cuInstruction, ...transaction.instructions];
  }

  // Fetch a fresh blockhash close to send time to avoid stale block height
  const freshBlockhash = await connection.getLatestBlockhash();
  transaction.recentBlockhash = freshBlockhash.blockhash;

  // Sign and send
  const signed = await provider.wallet.signTransaction(transaction);
  if (signers.length > 0) {
    signed.partialSign(...signers);
  }

  const signature = await connection.sendRawTransaction(signed.serialize());

  await connection.confirmTransaction(
    {
      signature,
      blockhash: freshBlockhash.blockhash,
      lastValidBlockHeight: freshBlockhash.lastValidBlockHeight,
    },
    provider.opts?.commitment ?? "confirmed",
  );

  return signature;
}
