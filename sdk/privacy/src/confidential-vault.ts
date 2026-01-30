import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionSignature,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { Program, AnchorProvider, BN, Idl, Wallet } from "@coral-xyz/anchor";
import {
  ConfidentialDepositParams,
  ConfidentialDepositResult,
  ConfidentialRedeemParams,
  ConfidentialWithdrawParams,
  ConfidentialWithdrawResult,
  ConfigureAccountParams,
  ApplyPendingParams,
  ConfidentialVaultState,
  ElGamalKeypair,
  AesKey,
} from "./types";
import {
  deriveElGamalKeypair,
  deriveAesKey,
  createDecryptableZeroBalance,
  createDecryptableBalance,
  decryptableBalanceToBytes,
} from "./encryption";
import {
  createPubkeyValidityProofData,
  createVerifyPubkeyValidityInstruction,
  createProofContextAccount,
  createEqualityProofData,
  createRangeProofData,
} from "./proofs";
import { ProofType } from "./types";

/**
 * SVS-2 Program ID
 */
export const SVS_2_PROGRAM_ID = new PublicKey(
  "SVS2VauLt2222222222222222222222222222222222",
);

/**
 * Vault seed for PDA derivation
 */
const VAULT_SEED = Buffer.from("vault");

/**
 * ConfidentialSolanaVault - SDK for SVS-2 Confidential Vault
 *
 * This class provides methods to interact with SVS-2 vaults that use
 * Token-2022 Confidential Transfers for private share balances.
 *
 * Key concepts:
 * - Shares are encrypted using ElGamal encryption
 * - Only the owner (with their ElGamal secret key) can decrypt balances
 * - ZK proofs are required for withdraw/redeem operations
 * - Deposits go to a pending balance that must be applied
 */
export class ConfidentialSolanaVault {
  private connection: Connection;
  private program: Program;
  private wallet: Wallet;

  constructor(connection: Connection, wallet: Wallet, idl: Idl) {
    this.connection = connection;
    this.wallet = wallet;

    const provider = new AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    this.program = new Program(idl, provider);
  }

  /**
   * Derive the vault PDA address
   */
  static deriveVaultAddress(
    assetMint: PublicKey,
    vaultId: BN,
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [VAULT_SEED, assetMint.toBuffer(), vaultId.toArrayLike(Buffer, "le", 8)],
      SVS_2_PROGRAM_ID,
    );
  }

  /**
   * Fetch vault state
   */
  async getVault(vaultAddress: PublicKey): Promise<ConfidentialVaultState> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vault = await (this.program.account as any).confidentialVault.fetch(
      vaultAddress,
    );

    return {
      authority: vault.authority,
      assetMint: vault.assetMint,
      sharesMint: vault.sharesMint,
      assetVault: vault.assetVault,
      totalAssets: vault.totalAssets,
      decimalsOffset: vault.decimalsOffset,
      bump: vault.bump,
      paused: vault.paused,
      vaultId: vault.vaultId,
      auditorElgamalPubkey: vault.auditorElgamalPubkey,
      confidentialAuthority: vault.confidentialAuthority,
    };
  }

  /**
   * Configure a user's shares account for confidential transfers
   *
   * This must be called before the first deposit. It:
   * 1. Derives the user's ElGamal keypair and AES key
   * 2. Creates a PubkeyValidityProof
   * 3. Configures the token account for confidential transfers
   *
   * @param params - Configuration parameters
   * @returns Transaction signature and derived keys
   */
  async configureAccount(params: ConfigureAccountParams): Promise<{
    signature: TransactionSignature;
    elgamalKeypair: ElGamalKeypair;
    aesKey: AesKey;
  }> {
    const vault = await this.getVault(params.vault);
    const userPubkey = this.wallet.publicKey;

    // Get or create user's shares ATA
    const userSharesAccount = getAssociatedTokenAddressSync(
      vault.sharesMint,
      userPubkey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    // Derive encryption keys
    const walletKeypair = (this.wallet as any).payer as Keypair;
    const elgamalKeypair = deriveElGamalKeypair(
      walletKeypair,
      userSharesAccount,
    );
    const aesKey = deriveAesKey(walletKeypair, userSharesAccount);

    // Create zero balance ciphertext
    const decryptableZeroBalance = createDecryptableZeroBalance(aesKey);

    // Create pubkey validity proof
    const proofData = createPubkeyValidityProofData(elgamalKeypair);
    const proofIx = createVerifyPubkeyValidityInstruction(proofData);

    // Build transaction with proof instruction preceding configure_account
    const tx = new Transaction();

    // Add ATA creation if needed
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        userPubkey,
        userSharesAccount,
        userPubkey,
        vault.sharesMint,
        TOKEN_2022_PROGRAM_ID,
      ),
    );

    // Add proof instruction (will be at offset -1 relative to configure_account)
    tx.add(proofIx);

    // Add configure_account instruction
    const configureIx = await this.program.methods
      .configureAccount(
        Array.from(decryptableZeroBalance.ciphertext),
        -1, // Proof is in preceding instruction
      )
      .accounts({
        user: userPubkey,
        vault: params.vault,
        sharesMint: vault.sharesMint,
        userSharesAccount,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    tx.add(configureIx);

    const signature = await this.program.provider.sendAndConfirm!(tx);

    return { signature, elgamalKeypair, aesKey };
  }

  /**
   * Deposit assets and receive confidential shares
   *
   * Shares go to the pending balance. Call applyPending() afterward
   * to make them available for transfers/withdrawals.
   *
   * @param params - Deposit parameters
   * @returns Deposit result with signature and amounts
   */
  async deposit(
    params: ConfidentialDepositParams,
  ): Promise<ConfidentialDepositResult> {
    const vault = await this.getVault(params.vault);
    const userPubkey = this.wallet.publicKey;

    // Get user accounts
    const userAssetAccount = getAssociatedTokenAddressSync(
      vault.assetMint,
      userPubkey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    const userSharesAccount = getAssociatedTokenAddressSync(
      vault.sharesMint,
      userPubkey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    // Preview shares to receive
    const sharesPreview = await this.previewDeposit(
      params.vault,
      params.assets,
    );

    const signature = await this.program.methods
      .deposit(params.assets, params.minSharesOut)
      .accounts({
        user: userPubkey,
        vault: params.vault,
        assetMint: vault.assetMint,
        userAssetAccount,
        assetVault: vault.assetVault,
        sharesMint: vault.sharesMint,
        userSharesAccount,
        assetTokenProgram: TOKEN_2022_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: getAssociatedTokenAddressSync(
          vault.assetMint,
          userPubkey,
        ),
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return {
      signature,
      sharesReceived: sharesPreview,
      assetsDeposited: params.assets,
    };
  }

  /**
   * Apply pending balance to available balance
   *
   * Must be called after deposit/mint before shares can be used.
   *
   * @param params - Apply pending parameters
   * @returns Transaction signature
   */
  async applyPending(
    params: ApplyPendingParams,
  ): Promise<TransactionSignature> {
    const vault = await this.getVault(params.vault);
    const userPubkey = this.wallet.publicKey;

    const userSharesAccount = getAssociatedTokenAddressSync(
      vault.sharesMint,
      userPubkey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    return await this.program.methods
      .applyPending(
        Array.from(params.newDecryptableAvailableBalance.ciphertext),
        params.expectedPendingBalanceCreditCounter,
      )
      .accounts({
        user: userPubkey,
        vault: params.vault,
        sharesMint: vault.sharesMint,
        userSharesAccount,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
  }

  /**
   * Withdraw exact assets by burning confidential shares
   *
   * Requires pre-verified proof context accounts.
   *
   * @param params - Withdraw parameters
   * @returns Withdraw result with signature and amounts
   */
  async withdraw(
    params: ConfidentialWithdrawParams,
  ): Promise<ConfidentialWithdrawResult> {
    const vault = await this.getVault(params.vault);
    const userPubkey = this.wallet.publicKey;

    const userAssetAccount = getAssociatedTokenAddressSync(
      vault.assetMint,
      userPubkey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    const userSharesAccount = getAssociatedTokenAddressSync(
      vault.sharesMint,
      userPubkey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    // Preview shares to burn
    const sharesPreview = await this.previewWithdraw(
      params.vault,
      params.assets,
    );

    const signature = await this.program.methods
      .withdraw(
        params.assets,
        params.maxSharesIn,
        Array.from(params.newDecryptableBalance.ciphertext),
      )
      .accounts({
        user: userPubkey,
        vault: params.vault,
        assetMint: vault.assetMint,
        userAssetAccount,
        assetVault: vault.assetVault,
        sharesMint: vault.sharesMint,
        userSharesAccount,
        equalityProofContext: params.equalityProofContext,
        rangeProofContext: params.rangeProofContext,
        assetTokenProgram: TOKEN_2022_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    return {
      signature,
      sharesBurned: sharesPreview,
      assetsReceived: params.assets,
    };
  }

  /**
   * Redeem confidential shares for assets
   *
   * Requires pre-verified proof context accounts.
   *
   * @param params - Redeem parameters
   * @returns Redeem result with signature and amounts
   */
  async redeem(
    params: ConfidentialRedeemParams,
  ): Promise<ConfidentialWithdrawResult> {
    const vault = await this.getVault(params.vault);
    const userPubkey = this.wallet.publicKey;

    const userAssetAccount = getAssociatedTokenAddressSync(
      vault.assetMint,
      userPubkey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    const userSharesAccount = getAssociatedTokenAddressSync(
      vault.sharesMint,
      userPubkey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    // Preview assets to receive
    const assetsPreview = await this.previewRedeem(params.vault, params.shares);

    const signature = await this.program.methods
      .redeem(
        params.shares,
        params.minAssetsOut,
        Array.from(params.newDecryptableBalance.ciphertext),
      )
      .accounts({
        user: userPubkey,
        vault: params.vault,
        assetMint: vault.assetMint,
        userAssetAccount,
        assetVault: vault.assetVault,
        sharesMint: vault.sharesMint,
        userSharesAccount,
        equalityProofContext: params.equalityProofContext,
        rangeProofContext: params.rangeProofContext,
        assetTokenProgram: TOKEN_2022_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    return {
      signature,
      sharesBurned: params.shares,
      assetsReceived: assetsPreview,
    };
  }

  /**
   * Create proof context accounts for withdraw/redeem
   *
   * This creates both the equality proof and range proof context accounts
   * needed for confidential withdraw/redeem operations.
   *
   * @param elgamalKeypair - User's ElGamal keypair
   * @param amount - Amount being withdrawn
   * @param currentBalance - Current encrypted balance
   * @returns Proof context public keys
   */
  async createWithdrawProofContexts(
    elgamalKeypair: ElGamalKeypair,
    amount: BN,
    currentBalance: Uint8Array,
  ): Promise<{
    equalityProofContext: PublicKey;
    rangeProofContext: PublicKey;
  }> {
    const payer = (this.wallet as any).payer as Keypair;

    // Create equality proof
    const equalityProofData = createEqualityProofData(
      elgamalKeypair,
      amount,
      currentBalance,
    );
    const { contextAccount: equalityProofContext } =
      await createProofContextAccount(
        this.connection,
        payer,
        ProofType.CiphertextCommitmentEquality,
        equalityProofData,
      );

    // Create range proof
    const rangeProofData = createRangeProofData([amount], [new Uint8Array(32)]);
    const { contextAccount: rangeProofContext } =
      await createProofContextAccount(
        this.connection,
        payer,
        ProofType.BatchedRangeProofU64,
        rangeProofData,
      );

    return { equalityProofContext, rangeProofContext };
  }

  // ============ View Functions ============

  /**
   * Preview shares for deposit (floor rounding)
   */
  async previewDeposit(vault: PublicKey, assets: BN): Promise<BN> {
    const vaultState = await this.getVault(vault);
    // Call view function via simulate
    // For simplicity, calculate client-side using same math
    return this.convertToShares(vault, assets);
  }

  /**
   * Preview assets for redeem (floor rounding)
   */
  async previewRedeem(vault: PublicKey, shares: BN): Promise<BN> {
    return this.convertToAssets(vault, shares);
  }

  /**
   * Preview shares for withdraw (ceiling rounding)
   */
  async previewWithdraw(vault: PublicKey, assets: BN): Promise<BN> {
    // Ceiling rounding for withdrawals
    const vaultState = await this.getVault(vault);
    const totalShares = await this.getTotalShares(vault);

    if (totalShares.isZero()) {
      return assets;
    }

    const virtualOffset = new BN(10).pow(new BN(vaultState.decimalsOffset));
    const numerator = assets.mul(totalShares.add(virtualOffset));
    const denominator = vaultState.totalAssets.add(new BN(1));

    // Ceiling: (a + b - 1) / b
    return numerator.add(denominator).sub(new BN(1)).div(denominator);
  }

  /**
   * Convert assets to shares (floor rounding)
   */
  async convertToShares(vault: PublicKey, assets: BN): Promise<BN> {
    const vaultState = await this.getVault(vault);
    const totalShares = await this.getTotalShares(vault);

    if (totalShares.isZero()) {
      return assets;
    }

    const virtualOffset = new BN(10).pow(new BN(vaultState.decimalsOffset));
    return assets
      .mul(totalShares.add(virtualOffset))
      .div(vaultState.totalAssets.add(new BN(1)));
  }

  /**
   * Convert shares to assets (floor rounding)
   */
  async convertToAssets(vault: PublicKey, shares: BN): Promise<BN> {
    const vaultState = await this.getVault(vault);
    const totalShares = await this.getTotalShares(vault);

    if (totalShares.isZero()) {
      return shares;
    }

    const virtualOffset = new BN(10).pow(new BN(vaultState.decimalsOffset));
    return shares
      .mul(vaultState.totalAssets.add(new BN(1)))
      .div(totalShares.add(virtualOffset));
  }

  /**
   * Get total shares supply
   */
  private async getTotalShares(vault: PublicKey): Promise<BN> {
    const vaultState = await this.getVault(vault);
    const mintInfo = await this.connection.getAccountInfo(
      vaultState.sharesMint,
    );
    if (!mintInfo) {
      throw new Error("Shares mint not found");
    }
    // Parse supply from mint account data (offset 36, 8 bytes LE)
    const supply = mintInfo.data.readBigUInt64LE(36);
    return new BN(supply.toString());
  }
}
