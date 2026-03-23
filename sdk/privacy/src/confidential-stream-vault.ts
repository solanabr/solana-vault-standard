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
  TOKEN_PROGRAM_ID,
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
  ConfidentialStreamVaultState,
  ElGamalKeypair,
  AesKey,
} from "./types";
import {
  deriveElGamalKeypair,
  deriveAesKey,
  createDecryptableZeroBalance,
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
 * SVS-6 Program ID
 */
export const SVS_6_PROGRAM_ID = new PublicKey(
  "2w7aL5ZrD2i9RpzQBGSPAg7s61wVc8Qs8gtuQUTojEDE",
);

/**
 * Vault seed for PDA derivation
 */
const VAULT_SEED = Buffer.from("confidential_stream_vault");

export interface StreamInfo {
  baseAssets: BN;
  streamAmount: BN;
  streamStart: BN;
  streamEnd: BN;
  effectiveTotal: BN;
  lastCheckpoint: BN;
}

/**
 * ConfidentialStreamVault - SDK for SVS-6 Confidential Streaming Yield Vault
 *
 * Combines SVS-3 (confidential vault with Token-2022 Confidential Transfers)
 * with SVS-5 (streaming yield distribution). Share balances are encrypted
 * via ElGamal, and yield accrues linearly over a configurable stream period.
 *
 * Key differences from SVS-3:
 * - Reads shares_mint.supply for total shares (same as SVS-5)
 * - Uses effectiveTotalAssets(now) for conversions instead of live balance
 * - Supports distributeYield() and checkpoint() for streaming yield
 */
export class ConfidentialStreamVault {
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
   * Detect the token program that owns a given mint (TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID).
   */
  private async getAssetTokenProgram(assetMint: PublicKey): Promise<PublicKey> {
    const info = await this.connection.getAccountInfo(assetMint);
    if (!info) throw new Error("Asset mint not found");
    if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
    return TOKEN_PROGRAM_ID;
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
      SVS_6_PROGRAM_ID,
    );
  }

  /**
   * Fetch vault state
   */
  async getVault(vaultAddress: PublicKey): Promise<ConfidentialStreamVaultState> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vault = await (this.program.account as any).confidentialStreamVault.fetch(
      vaultAddress,
    );

    return {
      authority: vault.authority,
      assetMint: vault.assetMint,
      sharesMint: vault.sharesMint,
      assetVault: vault.assetVault,
      decimalsOffset: vault.decimalsOffset,
      bump: vault.bump,
      paused: vault.paused,
      vaultId: vault.vaultId,
      auditorElgamalPubkey: vault.auditorElgamalPubkey,
      confidentialAuthority: vault.confidentialAuthority,
      baseAssets: vault.baseAssets,
      streamAmount: vault.streamAmount,
      streamStart: vault.streamStart,
      streamEnd: vault.streamEnd,
      lastCheckpoint: vault.lastCheckpoint,
    };
  }

  /**
   * Configure a user's shares account for confidential transfers
   *
   * This must be called before the first deposit. It:
   * 1. Derives the user's ElGamal keypair and AES key
   * 2. Creates a PubkeyValidityProof
   * 3. Configures the token account for confidential transfers
   */
  async configureAccount(params: ConfigureAccountParams): Promise<{
    signature: TransactionSignature;
    elgamalKeypair: ElGamalKeypair;
    aesKey: AesKey;
  }> {
    const vault = await this.getVault(params.vault);
    const userPubkey = this.wallet.publicKey;

    const userSharesAccount = getAssociatedTokenAddressSync(
      vault.sharesMint,
      userPubkey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    const walletKeypair = (this.wallet as any).payer as Keypair;
    const elgamalKeypair = deriveElGamalKeypair(
      walletKeypair,
      userSharesAccount,
    );
    const aesKey = deriveAesKey(walletKeypair, userSharesAccount);

    const decryptableZeroBalance = createDecryptableZeroBalance(aesKey);

    const proofData = createPubkeyValidityProofData(elgamalKeypair);
    const proofIx = createVerifyPubkeyValidityInstruction(proofData);

    const tx = new Transaction();

    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        userPubkey,
        userSharesAccount,
        userPubkey,
        vault.sharesMint,
        TOKEN_2022_PROGRAM_ID,
      ),
    );

    tx.add(proofIx);

    const configureIx = await this.program.methods
      .configureAccount(
        Array.from(decryptableZeroBalance.ciphertext),
        -1,
      )
      .accounts({
        user: userPubkey,
        vault: params.vault,
        sharesMint: vault.sharesMint,
        userSharesAccount,
        proofContextAccount: null,
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
   */
  async deposit(
    params: ConfidentialDepositParams,
  ): Promise<ConfidentialDepositResult> {
    const vault = await this.getVault(params.vault);
    const userPubkey = this.wallet.publicKey;
    const assetTokenProgram = await this.getAssetTokenProgram(vault.assetMint);

    const userAssetAccount = getAssociatedTokenAddressSync(
      vault.assetMint,
      userPubkey,
      false,
      assetTokenProgram,
    );

    const userSharesAccount = getAssociatedTokenAddressSync(
      vault.sharesMint,
      userPubkey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

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
        assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
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
        userSharesAccount,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
  }

  /**
   * Withdraw exact assets by burning confidential shares
   *
   * Requires pre-verified proof context accounts.
   */
  async withdraw(
    params: ConfidentialWithdrawParams,
  ): Promise<ConfidentialWithdrawResult> {
    const vault = await this.getVault(params.vault);
    const userPubkey = this.wallet.publicKey;
    const assetTokenProgram = await this.getAssetTokenProgram(vault.assetMint);

    const userAssetAccount = getAssociatedTokenAddressSync(
      vault.assetMint,
      userPubkey,
      false,
      assetTokenProgram,
    );

    const userSharesAccount = getAssociatedTokenAddressSync(
      vault.sharesMint,
      userPubkey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

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
        assetTokenProgram,
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
   */
  async redeem(
    params: ConfidentialRedeemParams,
  ): Promise<ConfidentialWithdrawResult> {
    const vault = await this.getVault(params.vault);
    const userPubkey = this.wallet.publicKey;
    const assetTokenProgram = await this.getAssetTokenProgram(vault.assetMint);

    const userAssetAccount = getAssociatedTokenAddressSync(
      vault.assetMint,
      userPubkey,
      false,
      assetTokenProgram,
    );

    const userSharesAccount = getAssociatedTokenAddressSync(
      vault.sharesMint,
      userPubkey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

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
        assetTokenProgram,
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
   * Creates both the equality proof and range proof context accounts
   * needed for confidential withdraw/redeem operations.
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

  // ============ Streaming Yield ============

  /**
   * Distribute yield as a time-interpolated stream.
   * Authority-only. Transfers yield tokens to the vault and starts a linear stream.
   */
  async distributeYield(
    vault: PublicKey,
    yieldAmount: BN,
    duration: BN,
  ): Promise<TransactionSignature> {
    const vaultState = await this.getVault(vault);
    const authorityPubkey = this.wallet.publicKey;
    const assetTokenProgram = await this.getAssetTokenProgram(vaultState.assetMint);

    const authorityAssetAccount = getAssociatedTokenAddressSync(
      vaultState.assetMint,
      authorityPubkey,
      false,
      assetTokenProgram,
    );

    return await this.program.methods
      .distributeYield(yieldAmount, duration)
      .accounts({
        authority: authorityPubkey,
        vault,
        assetMint: vaultState.assetMint,
        authorityAssetAccount,
        assetVault: vaultState.assetVault,
        assetTokenProgram,
      })
      .rpc();
  }

  /**
   * Checkpoint: materialize accrued streaming yield into base_assets.
   * Permissionless -- anyone can call.
   */
  async checkpoint(vault: PublicKey): Promise<TransactionSignature> {
    return await this.program.methods
      .checkpoint()
      .accounts({
        vault,
      })
      .rpc();
  }

  /**
   * Get stream info from vault state.
   * Returns base_assets, stream parameters, and client-computed effective total.
   */
  async getStreamInfo(vault: PublicKey): Promise<StreamInfo> {
    const state = await this.getVault(vault);
    const now = new BN(Math.floor(Date.now() / 1000));
    const effectiveTotal = this.computeEffectiveTotalAssets(state, now);

    return {
      baseAssets: state.baseAssets,
      streamAmount: state.streamAmount,
      streamStart: state.streamStart,
      streamEnd: state.streamEnd,
      effectiveTotal,
      lastCheckpoint: state.lastCheckpoint,
    };
  }

  // ============ View Functions ============

  /**
   * Compute effective total assets with streaming interpolation.
   * effectiveTotalAssets = baseAssets + streamAmount * min(elapsed, duration) / duration
   */
  effectiveTotalAssets(state: ConfidentialStreamVaultState, now?: BN): BN {
    const timestamp = now ?? new BN(Math.floor(Date.now() / 1000));
    return this.computeEffectiveTotalAssets(state, timestamp);
  }

  /**
   * Preview shares for deposit (floor rounding)
   */
  async previewDeposit(vault: PublicKey, assets: BN): Promise<BN> {
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
    const vaultState = await this.getVault(vault);
    const totalShares = await this.getTotalShares(vaultState.sharesMint);
    const now = new BN(Math.floor(Date.now() / 1000));
    const totalAssets = this.computeEffectiveTotalAssets(vaultState, now);

    if (totalShares.isZero()) {
      return assets;
    }

    const virtualOffset = new BN(10).pow(new BN(vaultState.decimalsOffset));
    const numerator = assets.mul(totalShares.add(virtualOffset));
    const denominator = totalAssets.add(new BN(1));

    // Ceiling: (a + b - 1) / b
    return numerator.add(denominator).sub(new BN(1)).div(denominator);
  }

  /**
   * Convert assets to shares (floor rounding)
   */
  async convertToShares(vault: PublicKey, assets: BN): Promise<BN> {
    const vaultState = await this.getVault(vault);
    const totalShares = await this.getTotalShares(vaultState.sharesMint);
    const now = new BN(Math.floor(Date.now() / 1000));
    const totalAssets = this.computeEffectiveTotalAssets(vaultState, now);

    if (totalShares.isZero()) {
      return assets;
    }

    const virtualOffset = new BN(10).pow(new BN(vaultState.decimalsOffset));
    return assets
      .mul(totalShares.add(virtualOffset))
      .div(totalAssets.add(new BN(1)));
  }

  /**
   * Convert shares to assets (floor rounding)
   */
  async convertToAssets(vault: PublicKey, shares: BN): Promise<BN> {
    const vaultState = await this.getVault(vault);
    const totalShares = await this.getTotalShares(vaultState.sharesMint);
    const now = new BN(Math.floor(Date.now() / 1000));
    const totalAssets = this.computeEffectiveTotalAssets(vaultState, now);

    if (totalShares.isZero()) {
      return shares;
    }

    const virtualOffset = new BN(10).pow(new BN(vaultState.decimalsOffset));
    return shares
      .mul(totalAssets.add(new BN(1)))
      .div(totalShares.add(virtualOffset));
  }

  // ============ Private Helpers ============

  /**
   * Get total shares supply from the shares mint account.
   */
  private async getTotalShares(sharesMint: PublicKey): Promise<BN> {
    const mintInfo = await this.connection.getAccountInfo(sharesMint);
    if (!mintInfo) throw new Error("Shares mint not found");
    const supply = mintInfo.data.readBigUInt64LE(36);
    return new BN(supply.toString());
  }

  private computeEffectiveTotalAssets(
    state: ConfidentialStreamVaultState,
    now: BN,
  ): BN {
    if (state.streamAmount.isZero() || now.lte(state.streamStart)) {
      return state.baseAssets;
    }

    if (now.gte(state.streamEnd)) {
      return state.baseAssets.add(state.streamAmount);
    }

    const elapsed = now.sub(state.streamStart);
    const duration = state.streamEnd.sub(state.streamStart);
    const accrued = state.streamAmount.mul(elapsed).div(duration);

    return state.baseAssets.add(accrued);
  }
}
