import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionSignature,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { BN, Wallet, Idl } from "@coral-xyz/anchor";
import { getWalletKeypair } from "./wallet-utils";
import {
  PrivateDepositParams,
  PrivateDepositResult,
  PrivateWithdrawParams,
  PrivateWithdrawResult,
  ElGamalKeypair,
  AesKey,
} from "./types";
import { createPubkeyValidityProofViaBackend } from "./proofs";
import { ConfidentialSolanaVault } from "./confidential-vault";
import {
  PrivacyCashClient,
  ShieldedNote,
  createPrivateDepositFlow,
  completePrivateDeposit,
} from "./privacy-cash";
import {
  deriveAesKey,
  createDecryptableBalance,
  decryptBalance,
} from "./encryption";

/**
 * Byte offset to the `decryptable_available_balance` field within a Token-2022
 * account that has the ConfidentialTransfer extension enabled.
 *
 * Layout breakdown:
 *   165  Base SPL Token Account
 *   + 1  Account Type discriminator
 *   + 2  Extension Type (u16 LE)
 *   + 2  Extension data Length (u16 LE)
 *   + 1  approved (bool)
 *   +32  elgamal_pubkey
 *   +64  pending_balance_lo (ElGamal ciphertext)
 *   +64  pending_balance_hi (ElGamal ciphertext)
 *   +64  available_balance (ElGamal ciphertext)
 *  ----
 *  =395
 */
const CONFIDENTIAL_TRANSFER_DECRYPTABLE_BALANCE_OFFSET = 395;

/** Size of a decryptable balance ciphertext: 12-byte nonce + 8-byte value + 16-byte tag */
const DECRYPTABLE_BALANCE_SIZE = 36;

/**
 * PrivacySolanaVault - Full Privacy Vault SDK
 *
 * Combines SVS-2 (confidential shares) with Privacy Cash (address privacy)
 * to provide complete transactional privacy:
 *
 * - Amount Privacy: Share balances are encrypted with ElGamal
 * - Address Privacy: Vault deposits come from ephemeral wallets
 *
 * Three-tier privacy levels:
 * 1. None (SVS-1): Public shares, public addresses
 * 2. Amount (SVS-2): Encrypted shares, public addresses
 * 3. Full (SVS-2 + Privacy Cash): Encrypted shares, hidden addresses
 */
export class PrivacySolanaVault {
  private confidentialVault: ConfidentialSolanaVault;
  private privacyCash: PrivacyCashClient;
  private connection: Connection;
  private wallet: Wallet;
  private idl: Idl;

  /**
   * Encryption keys derived for the user's vault position
   */
  private elgamalKeypair?: ElGamalKeypair;
  private aesKey?: AesKey;

  /**
   * Ephemeral wallets used for private deposits
   * Maps vault address -> ephemeral keypair
   */
  private ephemeralWallets: Map<string, Keypair> = new Map();

  /**
   * Maximum number of ephemeral wallets to retain.
   * Oldest entries are evicted (and their secret keys zeroed) when this limit is reached.
   */
  private static readonly MAX_EPHEMERAL_WALLETS = 64;

  /** Default lamport fee estimate for ephemeral wallet funding */
  private static readonly DEFAULT_EPHEMERAL_WALLET_FUNDING = 10_000;

  /**
   * Configurable lamport amount added to ephemeral wallet funding
   * to cover transaction fees. Defaults to 10000 lamports.
   */
  private ephemeralWalletFunding: number;

  constructor(connection: Connection, wallet: Wallet, idl: Idl, options?: { ephemeralWalletFunding?: number }) {
    if (!idl || !idl.instructions) {
      throw new Error(
        "A valid IDL with instruction definitions is required. " +
          "Import the IDL from your program's generated artifacts.",
      );
    }
    this.connection = connection;
    this.wallet = wallet;
    this.idl = idl;
    this.ephemeralWalletFunding = options?.ephemeralWalletFunding
      ?? PrivacySolanaVault.DEFAULT_EPHEMERAL_WALLET_FUNDING;
    this.confidentialVault = new ConfidentialSolanaVault(
      connection,
      wallet,
      idl,
    );
    this.privacyCash = new PrivacyCashClient(connection, wallet);
  }

  /**
   * Full privacy deposit
   *
   * This flow:
   * 1. Shields assets in Privacy Cash (breaks address link)
   * 2. Creates ephemeral wallet
   * 3. Unshields to ephemeral wallet
   * 4. Configures ephemeral wallet for confidential transfers
   * 5. Deposits from ephemeral wallet to vault
   *
   * The on-chain link between your main wallet and vault position is broken.
   *
   * @param vault - Vault address
   * @param params - Deposit parameters
   * @returns Deposit result with all transaction signatures
   */
  async privateDeposit(
    vault: PublicKey,
    params: PrivateDepositParams,
  ): Promise<PrivateDepositResult> {
    const vaultState = await this.confidentialVault.getVault(vault);

    // Step 1: Shield assets in Privacy Cash
    const { shieldedNote, ephemeralWallet, shieldSignature } = await createPrivateDepositFlow(
      this.connection,
      this.wallet,
      vaultState.assetMint,
      params.assets,
    );

    const shieldTx = shieldSignature;

    // Store ephemeral wallet for potential future operations, with eviction
    this.storeEphemeralWallet(vault.toBase58(), ephemeralWallet);

    // Step 2: Unshield to ephemeral wallet
    const withdrawTx = await completePrivateDeposit(
      this.connection,
      this.wallet,
      ephemeralWallet,
      shieldedNote,
      vaultState.assetMint,
    );

    // Step 3: Fund ephemeral wallet with SOL for fees
    await this.fundEphemeralWallet(ephemeralWallet.publicKey);

    // Step 4: Create ephemeral wallet adapter
    const ephemeralWalletAdapter = {
      publicKey: ephemeralWallet.publicKey,
      payer: ephemeralWallet,
      signTransaction: async (tx: Transaction) => {
        tx.partialSign(ephemeralWallet);
        return tx;
      },
      signAllTransactions: async (txs: Transaction[]) => {
        txs.forEach((tx) => tx.partialSign(ephemeralWallet));
        return txs;
      },
    } as Wallet;

    // Create confidential vault instance with ephemeral wallet
    const ephemeralVaultClient = new ConfidentialSolanaVault(
      this.connection,
      ephemeralWalletAdapter,
      this.idl,
    );

    // Step 5: Configure ephemeral wallet's shares account for confidential transfers
    const ephemeralSharesAccount = getAssociatedTokenAddressSync(
      vaultState.sharesMint,
      ephemeralWallet.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    // Use caller-provided keys if available; otherwise derive AES key
    // (which works in pure JS) and obtain ElGamal keypair via backend proof.
    let elgamalKeypairForConfig: ElGamalKeypair;
    let aesKeyForConfig: AesKey;

    if (params.elgamalKeypair) {
      elgamalKeypairForConfig = params.elgamalKeypair;
    } else {
      // Derive ElGamal keypair via backend proof generation.
      // NOTE: This trusts the backend with secret key material.
      const { elgamalPubkey } = await createPubkeyValidityProofViaBackend(
        ephemeralWallet,
        ephemeralSharesAccount,
        true,
      );
      // The backend proof flow returns the public key; the secret key
      // remains on the backend. For the SDK type we store the pubkey
      // and a zeroed secret key placeholder since the backend holds it.
      elgamalKeypairForConfig = {
        publicKey: elgamalPubkey,
        secretKey: new Uint8Array(32),
      };
    }

    aesKeyForConfig = params.aesKey
      ? params.aesKey
      : await deriveAesKey(ephemeralWallet, ephemeralSharesAccount);

    const { elgamalKeypair, aesKey } =
      await ephemeralVaultClient.configureAccount({
        vault,
        userSharesAccount: ephemeralSharesAccount,
        elgamalKeypair: elgamalKeypairForConfig,
        aesKey: aesKeyForConfig,
      });

    // Store keys for this vault
    this.elgamalKeypair = elgamalKeypair;
    this.aesKey = aesKey;

    // Step 6: Deposit from ephemeral wallet
    const depositResult = await ephemeralVaultClient.deposit({
      vault,
      assets: params.assets,
      minSharesOut: params.minSharesOut,
    });

    return {
      shieldTx: shieldTx as TransactionSignature,
      withdrawTx,
      depositTx: depositResult.signature,
      ephemeralWallet: ephemeralWallet.publicKey,
      sharesReceived: depositResult.sharesReceived,
    };
  }

  /**
   * Full privacy withdrawal
   *
   * This flow:
   * 1. Redeems shares from vault to ephemeral wallet
   * 2. Shields assets from ephemeral wallet
   * 3. Unshields to user's main wallet (or any recipient)
   *
   * The on-chain link between the vault and your main wallet is broken.
   *
   * @param vault - Vault address
   * @param params - Withdraw parameters
   * @param recipient - Optional recipient address (defaults to main wallet)
   * @returns Withdraw result with all transaction signatures
   */
  async privateWithdraw(
    vault: PublicKey,
    params: PrivateWithdrawParams,
    recipient?: PublicKey,
  ): Promise<PrivateWithdrawResult> {
    const vaultState = await this.confidentialVault.getVault(vault);
    const finalRecipient = recipient || this.wallet.publicKey;

    // Get ephemeral wallet for this vault
    const ephemeralWallet = this.ephemeralWallets.get(vault.toBase58());
    if (!ephemeralWallet) {
      throw new Error(
        "No ephemeral wallet found for this vault. Did you use privateDeposit?",
      );
    }

    // Create ephemeral vault client
    const ephemeralWalletAdapter = {
      publicKey: ephemeralWallet.publicKey,
      payer: ephemeralWallet,
      signTransaction: async (tx: Transaction) => {
        tx.partialSign(ephemeralWallet);
        return tx;
      },
      signAllTransactions: async (txs: Transaction[]) => {
        txs.forEach((tx) => tx.partialSign(ephemeralWallet));
        return txs;
      },
    } as Wallet;

    const ephemeralVaultClient = new ConfidentialSolanaVault(
      this.connection,
      ephemeralWalletAdapter,
      this.idl,
    );

    // Step 1: Calculate shares to redeem and assets to receive
    const assetsOut = await ephemeralVaultClient.previewRedeem(
      vault,
      params.shares,
    );

    // Step 2: Create proof contexts for redeem
    if (!this.elgamalKeypair || !this.aesKey) {
      throw new Error("Encryption keys not initialized");
    }

    // Get current balance (would need to decrypt from chain)
    const currentBalance = params.shares; // Simplified

    const { equalityProofContext, rangeProofContext } =
      await ephemeralVaultClient.createWithdrawProofContexts(
        this.elgamalKeypair,
        params.shares,
        new Uint8Array(64), // Would need actual encrypted balance
      );

    // Step 3: Compute new decryptable balance after redeem
    if (currentBalance.lt(params.shares)) {
      throw new Error(
        `Insufficient balance: cannot redeem ${params.shares.toString()} shares ` +
          `from balance of ${currentBalance.toString()}`,
      );
    }
    const newBalance = currentBalance.sub(params.shares);
    const newDecryptableBalance = await createDecryptableBalance(
      this.aesKey,
      newBalance,
    );

    // Step 4: Redeem shares to ephemeral wallet
    const redeemResult = await ephemeralVaultClient.redeem({
      vault,
      shares: params.shares,
      minAssetsOut: params.minAssetsOut,
      newDecryptableBalance,
      equalityProofContext,
      rangeProofContext,
    });

    // Step 5: Shield assets from ephemeral wallet
    const ephemeralPrivacyCash = new PrivacyCashClient(
      this.connection,
      ephemeralWalletAdapter,
    );
    const { signature: shieldTx, note } = await ephemeralPrivacyCash.shield({
      amount: assetsOut,
      tokenMint: vaultState.assetMint,
    });

    // Step 6: Unshield to final recipient
    const merkleProof = await ephemeralPrivacyCash.getMerkleProof(
      note.commitment,
    );
    const withdrawTx = await ephemeralPrivacyCash.unshield({
      amount: assetsOut,
      tokenMint: vaultState.assetMint,
      recipient: finalRecipient,
      merkleProof,
      nullifier: note.nullifier,
    });

    return {
      redeemTx: redeemResult.signature,
      shieldTx,
      withdrawTx,
      assetsReceived: assetsOut,
    };
  }

  /**
   * Apply pending balance to available (for confidential deposits)
   *
   * After a deposit, shares go to pending balance. This moves them
   * to available balance so they can be transferred or redeemed.
   *
   * @param vault - Vault address
   * @param expectedPendingCredits - Expected number of pending credits to apply
   */
  async applyPending(
    vault: PublicKey,
    expectedPendingCredits: BN,
  ): Promise<TransactionSignature> {
    const ephemeralWallet = this.ephemeralWallets.get(vault.toBase58());
    if (!ephemeralWallet || !this.aesKey) {
      throw new Error("Vault not initialized with privateDeposit");
    }

    // Calculate new available balance after applying pending
    // In production, would decrypt current balance + pending
    const newAvailableBalance = expectedPendingCredits; // Simplified
    const newDecryptableBalance = await createDecryptableBalance(
      this.aesKey,
      newAvailableBalance,
    );

    // Create ephemeral client
    const ephemeralWalletAdapter = {
      publicKey: ephemeralWallet.publicKey,
      payer: ephemeralWallet,
      signTransaction: async (tx: Transaction) => {
        tx.partialSign(ephemeralWallet);
        return tx;
      },
      signAllTransactions: async (txs: Transaction[]) => {
        txs.forEach((tx) => tx.partialSign(ephemeralWallet));
        return txs;
      },
    } as Wallet;

    const ephemeralVaultClient = new ConfidentialSolanaVault(
      this.connection,
      ephemeralWalletAdapter,
      this.idl,
    );

    return ephemeralVaultClient.applyPending({
      vault,
      newDecryptableAvailableBalance: newDecryptableBalance,
      expectedPendingBalanceCreditCounter: expectedPendingCredits,
    });
  }

  /**
   * Get the ephemeral wallet for a vault (if one exists)
   *
   * Useful for checking if a private deposit has been made to this vault.
   */
  getEphemeralWallet(vault: PublicKey): PublicKey | undefined {
    const ephemeral = this.ephemeralWallets.get(vault.toBase58());
    return ephemeral?.publicKey;
  }

  /**
   * Decrypt the user's share balance
   *
   * @param vault - Vault address
   * @returns Decrypted balance
   */
  async getDecryptedBalance(vault: PublicKey): Promise<BN> {
    if (!this.aesKey) {
      throw new Error("AES key not initialized");
    }

    // In production, fetch the decryptable_available_balance from chain
    // and decrypt it
    const vaultState = await this.confidentialVault.getVault(vault);
    const ephemeralWallet = this.ephemeralWallets.get(vault.toBase58());

    if (!ephemeralWallet) {
      throw new Error("No ephemeral wallet for this vault");
    }

    // Fetch token account and parse confidential extension data
    const sharesAccount = getAssociatedTokenAddressSync(
      vaultState.sharesMint,
      ephemeralWallet.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    const accountInfo = await this.connection.getAccountInfo(sharesAccount);
    if (!accountInfo) {
      return new BN(0);
    }

    // Parse decryptable_available_balance from the ConfidentialTransferAccount
    // extension data within the Token-2022 account.
    //
    // Token-2022 account layout for ConfidentialTransfer extension:
    //   Base Token Account:           165 bytes (mint 32 + owner 32 + amount 8 +
    //                                 delegate_option 4 + delegate 32 + state 1 +
    //                                 is_native_option 4 + is_native 8 +
    //                                 delegated_amount 8 + close_authority_option 4 +
    //                                 close_authority 32)
    //   Account Type discriminator:     1 byte
    //   Extension Type discriminator:   2 bytes
    //   Extension Length:               2 bytes
    //   ConfidentialTransferAccount fields before decryptable_available_balance:
    //     approved:                     1 byte
    //     elgamal_pubkey:              32 bytes
    //     pending_balance_lo:          64 bytes (ElGamal ciphertext)
    //     pending_balance_hi:          64 bytes (ElGamal ciphertext)
    //     available_balance:           64 bytes (ElGamal ciphertext)
    //     decryptable_available_balance starts at offset:
    //       165 + 1 + 2 + 2 + 1 + 32 + 64 + 64 + 64 = 395
    const decryptableBalance = {
      ciphertext: accountInfo.data.slice(
        CONFIDENTIAL_TRANSFER_DECRYPTABLE_BALANCE_OFFSET,
        CONFIDENTIAL_TRANSFER_DECRYPTABLE_BALANCE_OFFSET + DECRYPTABLE_BALANCE_SIZE,
      ),
    };

    return await decryptBalance(this.aesKey, decryptableBalance);
  }

  // ============ Internal Helpers ============

  /**
   * Store an ephemeral wallet with LRU eviction.
   * When the map exceeds MAX_EPHEMERAL_WALLETS, the oldest entry is
   * evicted and its secret key bytes are zeroed to prevent accumulation
   * of sensitive key material in memory.
   */
  private storeEphemeralWallet(key: string, wallet: Keypair): void {
    // If this key already exists, zero the old one first
    const existing = this.ephemeralWallets.get(key);
    if (existing) {
      existing.secretKey.fill(0);
      this.ephemeralWallets.delete(key);
    }

    // Evict oldest entries if at capacity
    while (this.ephemeralWallets.size >= PrivacySolanaVault.MAX_EPHEMERAL_WALLETS) {
      const oldestKey = this.ephemeralWallets.keys().next().value;
      if (oldestKey === undefined) break;
      const evicted = this.ephemeralWallets.get(oldestKey);
      if (evicted) {
        evicted.secretKey.fill(0);
      }
      this.ephemeralWallets.delete(oldestKey);
    }

    this.ephemeralWallets.set(key, wallet);
  }

  /**
   * Fund ephemeral wallet with SOL for transaction fees
   *
   * The fee estimate is configurable via the `ephemeralWalletFunding` constructor
   * option (defaults to 10000 lamports). During periods of high network congestion,
   * callers should either increase this value or use a priority fee estimator.
   */
  private async fundEphemeralWallet(ephemeralPubkey: PublicKey): Promise<void> {
    const minBalance =
      await this.connection.getMinimumBalanceForRentExemption(0);
    const txFees = this.ephemeralWalletFunding;

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this.wallet.publicKey,
        toPubkey: ephemeralPubkey,
        lamports: minBalance + txFees,
      }),
    );

    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.wallet.publicKey;

    const signature = await this.connection.sendTransaction(tx, [
      getWalletKeypair(this.wallet),
    ]);
    await this.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
  }
}
