/** derwa command group — manage derwa-wrapper program */

import { Command } from "commander";
import { registerInitDerwaCommand } from "./initialize";
import { registerWrapCommand } from "./wrap";
import { registerUnwrapCommand } from "./unwrap";

export function registerDerwaCommands(program: Command): void {
  const derwa = program
    .command("derwa")
    .description(
      "Manage derwa-wrapper program: cPOOL ↔ dePOOL wrap and unwrap",
    );
  registerInitDerwaCommand(derwa);
  registerWrapCommand(derwa);
  registerUnwrapCommand(derwa);
}
