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
  registerSvs9StatusCommand(svs9);
}
