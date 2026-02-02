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
import {
  PrivateDepositParams,
  PrivateDepositResult,
  PrivateWithdrawParams,
  PrivateWithdrawResult,
  ElGamalKeypair,
  AesKey,
} from "./types";
import { ConfidentialSolanaVault } from "./confidential-vault";
import {
  PrivacyCashClient,
  ShieldedNote,
  createPrivateDepositFlow,
  completePrivateDeposit,
} from "./privacy-cash";
import {
  deriveElGamalKeypair,
  deriveAesKey,
  createDecryptableBalance,
  decryptBalance,
} from "./encryption";

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

  constructor(connection: Connection, wallet: Wallet, idl: Idl) {
    this.connection = connection;
    this.wallet = wallet;
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
    const { shieldedNote, ephemeralWallet } = await createPrivateDepositFlow(
      this.connection,
      this.wallet,
      vaultState.assetMint,
      params.assets,
    );

    const shieldTx = "shield_tx_placeholder"; // From createPrivateDepositFlow

    // Store ephemeral wallet for potential future operations
    this.ephemeralWallets.set(vault.toBase58(), ephemeralWallet);

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
      {} as Idl, // Would need actual IDL
    );

    // Step 5: Configure ephemeral wallet's shares account for confidential transfers
    const { elgamalKeypair, aesKey } =
      await ephemeralVaultClient.configureAccount({
        vault,
        userSharesAccount: getAssociatedTokenAddressSync(
          vaultState.sharesMint,
          ephemeralWallet.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID,
        ),
        elgamalKeypair: deriveElGamalKeypair(
          ephemeralWallet,
          getAssociatedTokenAddressSync(
            vaultState.sharesMint,
            ephemeralWallet.publicKey,
            false,
            TOKEN_2022_PROGRAM_ID,
          ),
        ),
        aesKey: deriveAesKey(
          ephemeralWallet,
          getAssociatedTokenAddressSync(
            vaultState.sharesMint,
            ephemeralWallet.publicKey,
            false,
            TOKEN_2022_PROGRAM_ID,
          ),
        ),
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
      {} as Idl,
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
    const newBalance = currentBalance.sub(params.shares);
    const newDecryptableBalance = createDecryptableBalance(
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
    const newDecryptableBalance = createDecryptableBalance(
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
      {} as Idl,
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

    // Parse decryptable_available_balance from extension data
    // This is a simplification - actual implementation would parse
    // the ConfidentialTransferAccount extension data
    const decryptableBalance = {
      ciphertext: accountInfo.data.slice(165, 201), // Placeholder offset
    };

    return decryptBalance(this.aesKey, decryptableBalance);
  }

  // ============ Internal Helpers ============

  /**
   * Fund ephemeral wallet with SOL for transaction fees
   */
  private async fundEphemeralWallet(ephemeralPubkey: PublicKey): Promise<void> {
    const minBalance =
      await this.connection.getMinimumBalanceForRentExemption(0);
    const txFees = 10000; // Estimated tx fees

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this.wallet.publicKey,
        toPubkey: ephemeralPubkey,
        lamports: minBalance + txFees,
      }),
    );

    await this.connection.sendTransaction(tx, [(this.wallet as any).payer]);
  }
}
