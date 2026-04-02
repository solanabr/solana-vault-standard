import { Keypair } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";

/**
 * Safely extract a Keypair from an Anchor Wallet.
 *
 * Anchor's `NodeWallet` exposes a `.payer` Keypair, but the `Wallet` interface
 * does not guarantee this. Browser wallet adapters will never have it.
 * This helper validates the cast instead of using `(wallet as any).payer`.
 *
 * @param wallet - An Anchor Wallet instance (must be a NodeWallet with key access)
 * @returns The underlying Keypair
 * @throws If the wallet does not expose a Keypair with a secretKey
 */
export function getWalletKeypair(wallet: Wallet): Keypair {
  const payer = (wallet as Record<string, unknown>).payer;
  if (
    !payer ||
    typeof payer !== "object" ||
    !("secretKey" in (payer as object))
  ) {
    throw new Error(
      "Wallet does not expose a Keypair. Confidential operations require a " +
        "NodeWallet with direct key access. Browser wallets are not supported.",
    );
  }
  return payer as Keypair;
}
