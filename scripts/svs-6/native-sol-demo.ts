import * as anchor from "@coral-xyz/anchor";
import { BN, Idl, Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import {
  NativeSolStreamVault,
  CreateNativeSolVaultParams,
} from "../../sdk/core/src/native-sol-stream-vault";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const idl = require("../../target/idl/svs_6.json") as Idl;
  const programId = new PublicKey(idl.address);
  const program = new Program(idl, programId, provider);

  const vaultIdArg = process.argv[2] ?? "1";
  const shouldInit = process.argv.includes("--init");
  const vaultId = new BN(vaultIdArg);

  let vault: NativeSolStreamVault;

  if (shouldInit) {
    const params: CreateNativeSolVaultParams = {
      vaultId,
      name: "SVS-6 Native SOL Vault",
      symbol: "svSOL6",
      uri: "https://example.com/svs-6.json",
    };
    vault = await NativeSolStreamVault.create(program, params);
    console.log("Initialized vault:", vault.vault.toBase58());
  } else {
    vault = await NativeSolStreamVault.load(program, vaultId);
  }

  const user = provider.wallet.publicKey;

  const expectedShares = await vault.previewDeposit(new BN(100_000_000));
  const depositTx = await vault.deposit(user, {
    assets: new BN(100_000_000),
    minSharesOut: expectedShares.mul(new BN(95)).div(new BN(100)),
  });
  console.log("deposit tx:", depositTx);

  const distributeTx = await vault.distributeYield(user, {
    yieldAmount: new BN(50_000_000),
    durationSeconds: 60,
  });
  console.log("distribute_yield tx:", distributeTx);

  await new Promise((resolve) => setTimeout(resolve, 1500));

  const accrueTx = await vault.accrueYield();
  console.log("accrue_yield tx:", accrueTx);

  const totalAssets = await vault.totalAssets();
  console.log("effective total assets (lamports):", totalAssets.toString());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
