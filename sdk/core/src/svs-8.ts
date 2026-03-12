import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

export class MultiAssetVaultClient {
  program: Program;
  provider: AnchorProvider;

  constructor(program: Program, provider: AnchorProvider) {
    this.program = program;
    this.provider = provider;
  }

  async initialize(vault: PublicKey, payer: PublicKey) {
    return this.program.methods
      .initialize()
      .accounts({
        vault,
        payer,
      })
      .rpc();
  }

  async addAsset(vault: PublicKey, assetMint: PublicKey, weight: number) {
    return this.program.methods
      .addAsset(new BN(weight))
      .accounts({
        vault,
        assetMint,
      })
      .rpc();
  }

  async depositSingle(vault: PublicKey, user: PublicKey, amount: number) {
    return this.program.methods
      .depositSingle(new BN(amount))
      .accounts({
        vault,
        user,
      })
      .rpc();
  }

  async depositProportional(
    vault: PublicKey,
    user: PublicKey,
    baseAmount: number,
    minShares: number
  ) {
    return this.program.methods
      .depositProportional(new BN(baseAmount), new BN(minShares))
      .accounts({
        vault,
        user,
      })
      .rpc();
  }

  async redeemProportional(
    vault: PublicKey,
    user: PublicKey,
    shares: number,
    minAssets: number
  ) {
    return this.program.methods
      .redeemProportional(new BN(shares), new BN(minAssets))
      .accounts({
        vault,
        user,
      })
      .rpc();
  }
}
