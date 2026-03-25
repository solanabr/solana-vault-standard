/**
 * SVS-9 CLI Commands
 *
 * CLI integration for the AllocatorVault (SVS-9) operations.
 * Registers under the `svs9` command group.
 */

import { Command } from "commander";
import { registerSvs9InitCommand } from "./init";
import { registerSvs9AddChildCommand } from "./add-child";
import { registerSvs9AllocateCommand } from "./allocate";
import { registerSvs9DeallocateCommand } from "./deallocate";
import { registerSvs9HarvestCommand } from "./harvest";
import { registerSvs9RebalanceCommand } from "./rebalance";
import { registerSvs9RemoveChildCommand } from "./remove-child";
import { registerSvs9UpdateWeightsCommand } from "./update-weights";
import { registerSvs9SetCuratorCommand } from "./set-curator";
import { registerSvs9StatusCommand } from "./status";

/**
 * Register all SVS-9 allocator vault commands under a `svs9` subcommand.
 */
export function registerSvs9Commands(program: Command): void {
  const svs9 = program
    .command("svs9")
    .description("SVS-9 Allocator Vault commands");

  registerSvs9InitCommand(svs9);
  registerSvs9AddChildCommand(svs9);
  registerSvs9AllocateCommand(svs9);
  registerSvs9DeallocateCommand(svs9);
  registerSvs9HarvestCommand(svs9);
  registerSvs9RebalanceCommand(svs9);
  registerSvs9RemoveChildCommand(svs9);
  registerSvs9UpdateWeightsCommand(svs9);
  registerSvs9SetCuratorCommand(svs9);
  registerSvs9StatusCommand(svs9);
}
