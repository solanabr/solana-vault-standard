import { Command } from "commander";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { TranchedVault } from "../../../tranched-vault";
import { findIdlPath, loadIdl } from "../../utils";

export function registerTranchedAdminCommand(parent: Command): void {
  const admin = parent
    .command("admin")
    .description("Admin operations for tranched vaults");

  admin
    .command("pause")
    .description("Pause the vault")
    .requiredOption("--asset-mint <pubkey>", "Asset mint address")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;

      try {
        const idl = loadIdl(findIdlPath("svs-12")!);
        const prog = new Program(idl as any, provider);
        const vault = await TranchedVault.load(
          prog,
          new PublicKey(opts.assetMint),
          new BN(opts.vaultId),
        );
        const sig = await vault.pause(wallet.publicKey);
        output.success(`Vault paused. Signature: ${sig}`);
      } catch (error) {
        output.error(
          `Failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  admin
    .command("unpause")
    .description("Unpause the vault")
    .requiredOption("--asset-mint <pubkey>", "Asset mint address")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;

      try {
        const idl = loadIdl(findIdlPath("svs-12")!);
        const prog = new Program(idl as any, provider);
        const vault = await TranchedVault.load(
          prog,
          new PublicKey(opts.assetMint),
          new BN(opts.vaultId),
        );
        const sig = await vault.unpause(wallet.publicKey);
        output.success(`Vault unpaused. Signature: ${sig}`);
      } catch (error) {
        output.error(
          `Failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  admin
    .command("transfer-authority")
    .description(
      "[legacy single-step] Transfer vault authority. Prefer request-transfer-authority + accept-authority.",
    )
    .requiredOption("--asset-mint <pubkey>", "Asset mint address")
    .option("--vault-id <number>", "Vault ID", "1")
    .requiredOption("--new-authority <pubkey>", "New authority address")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet, options } = ctx;

      if (!options.yes) {
        const confirmed = await output.confirm(
          "Transfer authority? This is irreversible.",
        );
        if (!confirmed) return;
      }

      try {
        const idl = loadIdl(findIdlPath("svs-12")!);
        const prog = new Program(idl as any, provider);
        const vault = await TranchedVault.load(
          prog,
          new PublicKey(opts.assetMint),
          new BN(opts.vaultId),
        );
        const sig = await vault.transferAuthority(
          wallet.publicKey,
          new PublicKey(opts.newAuthority),
        );
        output.success(`Authority transferred. Signature: ${sig}`);
      } catch (error) {
        output.error(
          `Failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  admin
    .command("request-transfer-authority")
    .description(
      "Step 1/2: nominate a new authority as pending (current authority only)",
    )
    .requiredOption("--asset-mint <pubkey>", "Asset mint address")
    .option("--vault-id <number>", "Vault ID", "1")
    .requiredOption("--new-authority <pubkey>", "Address to nominate")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;

      try {
        const idl = loadIdl(findIdlPath("svs-12")!);
        const prog = new Program(idl as any, provider);
        const vault = await TranchedVault.load(
          prog,
          new PublicKey(opts.assetMint),
          new BN(opts.vaultId),
        );
        const sig = await vault.requestTransferAuthority(
          wallet.publicKey,
          new PublicKey(opts.newAuthority),
        );
        output.success(
          `Pending authority set. The nominee must run accept-authority. Signature: ${sig}`,
        );
      } catch (error) {
        output.error(
          `Failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  admin
    .command("accept-authority")
    .description(
      "Step 2/2: accept a pending authority transfer (nominee signs)",
    )
    .requiredOption("--asset-mint <pubkey>", "Asset mint address")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;

      try {
        const idl = loadIdl(findIdlPath("svs-12")!);
        const prog = new Program(idl as any, provider);
        const vault = await TranchedVault.load(
          prog,
          new PublicKey(opts.assetMint),
          new BN(opts.vaultId),
        );
        const sig = await vault.acceptAuthority(wallet.publicKey);
        output.success(
          `Authority is now ${wallet.publicKey.toBase58()}. Signature: ${sig}`,
        );
      } catch (error) {
        output.error(
          `Failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  admin
    .command("cancel-transfer-authority")
    .description("Clear a pending authority transfer (current authority only)")
    .requiredOption("--asset-mint <pubkey>", "Asset mint address")
    .option("--vault-id <number>", "Vault ID", "1")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;

      try {
        const idl = loadIdl(findIdlPath("svs-12")!);
        const prog = new Program(idl as any, provider);
        const vault = await TranchedVault.load(
          prog,
          new PublicKey(opts.assetMint),
          new BN(opts.vaultId),
        );
        const sig = await vault.cancelTransferAuthority(wallet.publicKey);
        output.success(`Pending authority transfer cleared. Signature: ${sig}`);
      } catch (error) {
        output.error(
          `Failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  admin
    .command("set-manager")
    .description("Set vault manager")
    .requiredOption("--asset-mint <pubkey>", "Asset mint address")
    .option("--vault-id <number>", "Vault ID", "1")
    .requiredOption("--new-manager <pubkey>", "New manager address")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;

      try {
        const idl = loadIdl(findIdlPath("svs-12")!);
        const prog = new Program(idl as any, provider);
        const vault = await TranchedVault.load(
          prog,
          new PublicKey(opts.assetMint),
          new BN(opts.vaultId),
        );
        const sig = await vault.setManager(
          wallet.publicKey,
          new PublicKey(opts.newManager),
        );
        output.success(`Manager updated. Signature: ${sig}`);
      } catch (error) {
        output.error(
          `Failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  admin
    .command("update-tranche")
    .description("Update tranche configuration")
    .requiredOption("--asset-mint <pubkey>", "Asset mint address")
    .option("--vault-id <number>", "Vault ID", "1")
    .requiredOption("-t, --tranche <number>", "Tranche index")
    .option("--yield-bps <number>", "Target yield basis points")
    .option("--cap-bps <number>", "Cap basis points")
    .option("--sub-bps <number>", "Subordination basis points")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;

      try {
        const idl = loadIdl(findIdlPath("svs-12")!);
        const prog = new Program(idl as any, provider);
        const vault = await TranchedVault.load(
          prog,
          new PublicKey(opts.assetMint),
          new BN(opts.vaultId),
        );
        const sig = await vault.updateTrancheConfig(
          wallet.publicKey,
          parseInt(opts.tranche),
          {
            targetYieldBps: opts.yieldBps ? parseInt(opts.yieldBps) : undefined,
            capBps: opts.capBps ? parseInt(opts.capBps) : undefined,
            subordinationBps: opts.subBps ? parseInt(opts.subBps) : undefined,
          },
        );
        output.success(`Tranche config updated. Signature: ${sig}`);
      } catch (error) {
        output.error(
          `Failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}
