/** Access Commands - View and manage access control configuration */

import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { resolveVaultArg, saveConfig, isValidPublicKey } from "../../utils";
import {
  AccessConfig,
  AccessMode,
  checkAccess,
  addToList,
  removeFromList,
  createOpenConfig,
  createWhitelistConfig,
  createBlacklistConfig,
  generateMerkleProof,
  generateMerkleRoot,
} from "../../../access-control";

export function registerAccessCommands(program: Command): void {
  const access = program
    .command("access")
    .description("View and manage vault access control");

  access
    .command("show")
    .description("Display current access control configuration")
    .argument("<vault>", "Vault address or alias")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      const storedAccess = config.access?.[vaultArg] as
        | {
            mode: AccessMode;
            merkleRoot?: string;
            addresses?: string[];
          }
        | undefined;

      if (!storedAccess) {
        output.info(`No access control configured for ${vaultArg}`);
        output.info("Default: OPEN (anyone can deposit/withdraw)");
        output.info("");
        output.info("Configure access with:");
        output.info(
          `  solana-vault access set-mode ${vaultArg} --mode whitelist`,
        );
        return;
      }

      const listSize = storedAccess.addresses?.length ?? 0;

      if (globalOpts.output === "json") {
        output.json({
          vault: vaultArg,
          access: {
            mode: storedAccess.mode,
            listSize,
            merkleRoot: storedAccess.merkleRoot,
            addresses: storedAccess.addresses,
          },
        });
        return;
      }

      output.info(`Access Control for ${vaultArg}\n`);

      const modeDescription = {
        [AccessMode.Open]: "Anyone can deposit/withdraw",
        [AccessMode.Whitelist]: "Only whitelisted addresses allowed",
        [AccessMode.Blacklist]: "All except blacklisted addresses allowed",
      };

      output.table(
        ["Property", "Value"],
        [
          ["Mode", storedAccess.mode.toUpperCase()],
          ["Description", modeDescription[storedAccess.mode]],
          ["List Size", listSize.toString()],
          ["Merkle Root", storedAccess.merkleRoot ? "Set" : "None"],
        ],
      );

      if (listSize > 0 && listSize <= 20) {
        output.info("\nAddresses:");
        storedAccess.addresses?.forEach((addr, i) => {
          output.info(`  ${i + 1}. ${addr}`);
        });
      } else if (listSize > 20) {
        output.info(`\n(${listSize} addresses - use --output json to see all)`);
      }
    });

  access
    .command("set-mode")
    .description("Set access control mode")
    .argument("<vault>", "Vault address or alias")
    .requiredOption(
      "--mode <mode>",
      "Access mode: open, whitelist, or blacklist",
    )
    .option("--use-merkle", "Use merkle tree for large lists")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      const resolved = resolveVaultArg(vaultArg, config, opts, output);
      if (!resolved) process.exit(1);

      const mode = opts.mode.toLowerCase();
      if (!["open", "whitelist", "blacklist"].includes(mode)) {
        output.error("Mode must be: open, whitelist, or blacklist");
        process.exit(1);
      }

      let newAccessConfig: AccessConfig;

      switch (mode) {
        case "open":
          newAccessConfig = createOpenConfig();
          break;
        case "whitelist":
          newAccessConfig = createWhitelistConfig([], opts.useMerkle ?? false);
          break;
        case "blacklist":
          newAccessConfig = createBlacklistConfig([]);
          break;
        default:
          output.error("Invalid mode");
          process.exit(1);
      }

      if (!config.access) {
        config.access = {};
      }
      // Store as serializable format
      config.access[vaultArg] = {
        mode: newAccessConfig.mode,
        merkleRoot: newAccessConfig.merkleRoot
          ? newAccessConfig.merkleRoot.toString("hex")
          : undefined,
        addresses: Array.from(newAccessConfig.addresses),
      };

      saveConfig(config);

      output.success(
        `Access mode set to ${mode.toUpperCase()} for ${vaultArg}`,
      );

      if (mode !== "open") {
        output.info("");
        output.info(
          `Add addresses with: solana-vault access add ${vaultArg} --address <PUBKEY>`,
        );
      }
    });

  access
    .command("add")
    .description("Add address to whitelist/blacklist")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--address <pubkey>", "Address to add")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      const storedAccess = config.access?.[vaultArg] as
        | {
            mode: AccessMode;
            merkleRoot?: string;
            addresses?: string[];
          }
        | undefined;

      if (!storedAccess) {
        output.error(`No access control configured for ${vaultArg}`);
        output.info(
          `Set mode first: solana-vault access set-mode ${vaultArg} --mode whitelist`,
        );
        process.exit(1);
      }

      if (storedAccess.mode === AccessMode.Open) {
        output.error("Cannot add addresses in OPEN mode");
        process.exit(1);
      }

      if (!isValidPublicKey(opts.address)) {
        output.error("Invalid address format");
        process.exit(1);
      }

      const address = new PublicKey(opts.address);

      // Reconstruct AccessConfig from stored data
      const accessConfig: AccessConfig = {
        mode: storedAccess.mode,
        merkleRoot: storedAccess.merkleRoot
          ? Buffer.from(storedAccess.merkleRoot, "hex")
          : null,
        addresses: new Set(storedAccess.addresses ?? []),
      };

      const updatedConfig = addToList(accessConfig, address);

      // Update merkle root if list is large enough
      let newMerkleRoot: Buffer | null = updatedConfig.merkleRoot;
      if (updatedConfig.addresses.size >= 10) {
        const addresses = Array.from(updatedConfig.addresses).map(
          (a) => new PublicKey(a),
        );
        newMerkleRoot = generateMerkleRoot(addresses);
      }

      config.access![vaultArg] = {
        mode: updatedConfig.mode,
        merkleRoot: newMerkleRoot ? newMerkleRoot.toString("hex") : undefined,
        addresses: Array.from(updatedConfig.addresses),
      };
      saveConfig(config);

      const listName =
        storedAccess.mode === AccessMode.Whitelist ? "whitelist" : "blacklist";
      output.success(`Added ${opts.address} to ${listName}`);
      output.info(`Total addresses: ${updatedConfig.addresses.size}`);
    });

  access
    .command("remove")
    .description("Remove address from whitelist/blacklist")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--address <pubkey>", "Address to remove")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      const storedAccess = config.access?.[vaultArg] as
        | {
            mode: AccessMode;
            merkleRoot?: string;
            addresses?: string[];
          }
        | undefined;

      if (!storedAccess) {
        output.error(`No access control configured for ${vaultArg}`);
        process.exit(1);
      }

      if (!isValidPublicKey(opts.address)) {
        output.error("Invalid address format");
        process.exit(1);
      }

      const address = new PublicKey(opts.address);

      // Reconstruct AccessConfig from stored data
      const accessConfig: AccessConfig = {
        mode: storedAccess.mode,
        merkleRoot: storedAccess.merkleRoot
          ? Buffer.from(storedAccess.merkleRoot, "hex")
          : null,
        addresses: new Set(storedAccess.addresses ?? []),
      };

      const updatedConfig = removeFromList(accessConfig, address);

      // Update merkle root if list is large enough
      let newMerkleRoot: Buffer | null = null;
      if (updatedConfig.addresses.size >= 10) {
        const addresses = Array.from(updatedConfig.addresses).map(
          (a) => new PublicKey(a),
        );
        newMerkleRoot = generateMerkleRoot(addresses);
      }

      config.access![vaultArg] = {
        mode: updatedConfig.mode,
        merkleRoot: newMerkleRoot ? newMerkleRoot.toString("hex") : undefined,
        addresses: Array.from(updatedConfig.addresses),
      };
      saveConfig(config);

      const listName =
        storedAccess.mode === AccessMode.Whitelist ? "whitelist" : "blacklist";
      output.success(`Removed ${opts.address} from ${listName}`);
      output.info(`Total addresses: ${updatedConfig.addresses.size}`);
    });

  access
    .command("check")
    .description("Check if an address has access")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--address <pubkey>", "Address to check")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      const storedAccess = config.access?.[vaultArg] as
        | {
            mode: AccessMode;
            merkleRoot?: string;
            addresses?: string[];
          }
        | undefined;

      if (!storedAccess || storedAccess.mode === AccessMode.Open) {
        output.success("Access mode is OPEN - all addresses allowed");
        return;
      }

      if (!isValidPublicKey(opts.address)) {
        output.error("Invalid address format");
        process.exit(1);
      }

      const address = new PublicKey(opts.address);

      // Reconstruct AccessConfig from stored data
      const accessConfig: AccessConfig = {
        mode: storedAccess.mode,
        merkleRoot: storedAccess.merkleRoot
          ? Buffer.from(storedAccess.merkleRoot, "hex")
          : null,
        addresses: new Set(storedAccess.addresses ?? []),
      };

      // Generate proof if using merkle tree
      let proofData: { proof: Buffer[]; leaf: Buffer } | undefined;
      if (storedAccess.merkleRoot && storedAccess.addresses) {
        const addresses = storedAccess.addresses.map((a) => new PublicKey(a));
        const merkleProof = generateMerkleProof(address, addresses);
        if (merkleProof) {
          proofData = { proof: merkleProof.proof, leaf: merkleProof.leaf };
        }
      }

      const result = checkAccess(address, accessConfig, proofData);

      if (globalOpts.output === "json") {
        output.json({
          vault: vaultArg,
          address: opts.address,
          allowed: result.allowed,
          reason: result.reason,
        });
        return;
      }

      if (result.allowed) {
        output.success(`${opts.address} has access`);
      } else {
        output.error(`${opts.address} does NOT have access`);
        if (result.reason) {
          output.info(`Reason: ${result.reason}`);
        }
      }
    });

  access
    .command("generate-proof")
    .description("Generate merkle proof for an address")
    .argument("<vault>", "Vault address or alias")
    .requiredOption("--address <pubkey>", "Address to generate proof for")
    .action(async (vaultArg, opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, true, false);
      const { output, config } = ctx;

      const storedAccess = config.access?.[vaultArg] as
        | {
            mode: AccessMode;
            merkleRoot?: string;
            addresses?: string[];
          }
        | undefined;

      if (!storedAccess || !storedAccess.merkleRoot) {
        output.error("Merkle proofs only available when merkle root is set");
        process.exit(1);
      }

      if (!storedAccess.addresses || storedAccess.addresses.length === 0) {
        output.error("No addresses in list - cannot generate proof");
        process.exit(1);
      }

      if (!isValidPublicKey(opts.address)) {
        output.error("Invalid address format");
        process.exit(1);
      }

      const address = new PublicKey(opts.address);
      const addresses = storedAccess.addresses.map((a) => new PublicKey(a));
      const merkleProof = generateMerkleProof(address, addresses);

      if (!merkleProof) {
        output.error("Address not found in list - cannot generate proof");
        process.exit(1);
      }

      if (globalOpts.output === "json") {
        output.json({
          vault: vaultArg,
          address: opts.address,
          merkleRoot: storedAccess.merkleRoot,
          proof: merkleProof.proof.map((p) => p.toString("hex")),
        });
      } else {
        output.info(`Merkle Proof for ${opts.address}\n`);
        output.info(`Root: ${storedAccess.merkleRoot}`);
        output.info("");
        output.info("Proof:");
        merkleProof.proof.forEach((p, i) => {
          output.info(`  ${i}: ${p.toString("hex")}`);
        });
      }
    });

  access
    .command("clear")
    .description("Clear access configuration (reset to OPEN)")
    .argument("<vault>", "Vault address or alias")
    .action(async (vaultArg) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, {}, true, false);
      const { output, config, options } = ctx;

      if (!config.access?.[vaultArg]) {
        output.info(`No access configuration for ${vaultArg}`);
        return;
      }

      if (!options.yes) {
        const confirmed = await output.confirm(
          `Clear access control for ${vaultArg}? (will reset to OPEN)`,
        );
        if (!confirmed) {
          output.warn("Aborted.");
          return;
        }
      }

      delete config.access[vaultArg];
      saveConfig(config);

      output.success(`Access control cleared for ${vaultArg}`);
    });
}
