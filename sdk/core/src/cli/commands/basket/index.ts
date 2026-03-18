/**
 * Basket Vault CLI Commands (SVS-8)
 *
 * Command group for managing multi-asset basket vaults.
 *
 * @example
 * ```bash
 * solana-vault basket init 1
 * solana-vault basket info 1
 * solana-vault basket add-asset 1 <mint> <oracle> 5000
 * solana-vault basket set-price 1 <mint> 1000000000
 * solana-vault basket deposit 1 --amount 1000000
 * solana-vault basket redeem 1 --shares 500000000
 * solana-vault basket pause 1
 * solana-vault basket unpause 1
 * solana-vault basket transfer-authority 1 <new-authority>
 * ```
 */
import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { findIdlPath, loadIdl } from "../../utils";
import {
  BasketVault,
  getBasketVaultAddress,
  getAssetEntryAddress,
  getOraclePriceAddress,
  PRICE_SCALE,
} from "../../../svs-8";

function loadBasketIdl(output: any): any {
  const path = require("path");
  const fs = require("fs");
  const idlPath = path.join(process.cwd(), "target/idl/svs_8.json");
  if (!fs.existsSync(idlPath)) {
    output.error("SVS-8 IDL not found. Run `anchor build` first.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(idlPath, "utf-8"));
}

export function registerBasketCommands(program: Command): void {
  const basket = program
    .command("basket")
    .description("Multi-asset basket vault operations (SVS-8)");

  // ── info ──────────────────────────────────────────────────────────────────
  basket
    .command("info <vault-id>")
    .description("Show basket vault state")
    .action(async (vaultIdArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, false, false);
      const { output, provider } = ctx;
      const idl = loadBasketIdl(output);
      const prog = new Program(idl, provider);
      const vaultId = new BN(vaultIdArg);
      const basket = await BasketVault.load(prog, vaultId);
      const state = await basket.fetchState();
      output.info(`Vault ID:     ${vaultId.toString()}`);
      output.info(`Vault PDA:    ${basket.vault.toBase58()}`);
      output.info(`Shares Mint:  ${basket.sharesMint.toBase58()}`);
      output.info(`Authority:    ${state.authority.toBase58()}`);
      output.info(`Total Shares: ${state.totalShares.toString()}`);
      output.info(`Num Assets:   ${state.numAssets}`);
      output.info(`Base Decimals:${state.baseDecimals}`);
      output.info(`Paused:       ${state.paused}`);
    });

  // ── init ──────────────────────────────────────────────────────────────────
  basket
    .command("init <vault-id>")
    .description("Initialize a new basket vault")
    .option("--name <string>", "Vault name", "SVS-8 Basket")
    .option("--symbol <string>", "Share token symbol", "BSKT")
    .option("--uri <string>", "Metadata URI", "https://example.com")
    .option("--base-decimals <number>", "Base decimals for pricing", "6")
    .action(async (vaultIdArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;
      const idl = loadBasketIdl(output);
      const prog = new Program(idl, provider);
      const b = await BasketVault.create(prog, wallet.publicKey, {
        vaultId: new BN(vaultIdArg),
        name: opts.name,
        symbol: opts.symbol,
        uri: opts.uri,
        baseDecimals: parseInt(opts.baseDecimals),
      });
      output.success(`Basket vault initialized!`);
      output.info(`Vault PDA:   ${b.vault.toBase58()}`);
      output.info(`Shares Mint: ${b.sharesMint.toBase58()}`);
    });

  // ── add-asset ─────────────────────────────────────────────────────────────
  basket
    .command("add-asset <vault-id> <mint> <oracle> <weight-bps>")
    .description("Add an asset to the basket")
    .action(async (vaultIdArg, mintArg, oracleArg, weightArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;
      const idl = loadBasketIdl(output);
      const prog = new Program(idl, provider);
      const b = await BasketVault.load(prog, new BN(vaultIdArg));
      const assetMint = new PublicKey(mintArg);
      const assetVaultKeypair = Keypair.generate();
      const tx = await b.addAsset(wallet.publicKey, {
        assetMint,
        assetVault: assetVaultKeypair.publicKey,
        oracle: new PublicKey(oracleArg),
        targetWeightBps: parseInt(weightArg),
      });
      output.success(`Asset added! tx: ${tx}`);
      output.info(`Asset Vault: ${assetVaultKeypair.publicKey.toBase58()}`);
    });

  // ── set-price ─────────────────────────────────────────────────────────────
  basket
    .command("set-price <vault-id> <mint> <price>")
    .description(`Set oracle price for an asset (scaled by ${PRICE_SCALE.toString()})`)
    .action(async (vaultIdArg, mintArg, priceArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;
      const idl = loadBasketIdl(output);
      const prog = new Program(idl, provider);
      const b = await BasketVault.load(prog, new BN(vaultIdArg));
      const tx = await b.updateOracle(wallet.publicKey, {
        assetMint: new PublicKey(mintArg),
        price: new BN(priceArg),
      });
      output.success(`Oracle price set! tx: ${tx}`);
    });

  // ── pause ─────────────────────────────────────────────────────────────────
  basket
    .command("pause <vault-id>")
    .description("Pause the basket vault (emergency)")
    .action(async (vaultIdArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;
      const idl = loadBasketIdl(output);
      const prog = new Program(idl, provider);
      const b = await BasketVault.load(prog, new BN(vaultIdArg));
      const tx = await b.pause(wallet.publicKey);
      output.success(`Vault paused! tx: ${tx}`);
    });

  // ── unpause ───────────────────────────────────────────────────────────────
  basket
    .command("unpause <vault-id>")
    .description("Unpause the basket vault")
    .action(async (vaultIdArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;
      const idl = loadBasketIdl(output);
      const prog = new Program(idl, provider);
      const b = await BasketVault.load(prog, new BN(vaultIdArg));
      const tx = await b.unpause(wallet.publicKey);
      output.success(`Vault unpaused! tx: ${tx}`);
    });

  // ── transfer-authority ────────────────────────────────────────────────────
  basket
    .command("transfer-authority <vault-id> <new-authority>")
    .description("Transfer vault authority to a new address")
    .action(async (vaultIdArg, newAuthorityArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;
      const idl = loadBasketIdl(output);
      const prog = new Program(idl, provider);
      const b = await BasketVault.load(prog, new BN(vaultIdArg));
      const tx = await b.transferAuthority(wallet.publicKey, new PublicKey(newAuthorityArg));
      output.success(`Authority transferred! tx: ${tx}`);
    });
}
