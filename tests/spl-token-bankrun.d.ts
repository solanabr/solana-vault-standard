declare module "spl-token-bankrun" {
  import type { BanksClient } from "solana-bankrun";
  import type { PublicKey, Signer } from "@solana/web3.js";

  export function createMint(
    banksClient: BanksClient,
    payer: Signer,
    mintAuthority: PublicKey,
    freezeAuthority: PublicKey | null,
    decimals: number
  ): Promise<PublicKey>;

  export function createAssociatedTokenAccount(
    banksClient: BanksClient,
    payer: Signer,
    mint: PublicKey,
    owner: PublicKey
  ): Promise<PublicKey>;

  export function mintTo(
    banksClient: BanksClient,
    payer: Signer,
    mint: PublicKey,
    destination: PublicKey,
    authority: Signer,
    amount: bigint
  ): Promise<void>;

  export function getAccount(
    banksClient: BanksClient,
    address: PublicKey
  ): Promise<{ amount: bigint }>;
}
