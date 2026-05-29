/** nav command group — manage nav-oracle program */

import { Command } from "commander";
import { registerInitNavAccountCommand } from "./initialize-nav-account";
import { registerPublishNavCommand } from "./publish-nav";
import { registerRotatePublisherCommand } from "./rotate-publisher";

export function registerNavCommands(program: Command): void {
  const nav = program
    .command("nav")
    .description(
      "Manage nav-oracle program: NavAccount, NAV publishing, publisher rotation",
    );
  registerInitNavAccountCommand(nav);
  registerPublishNavCommand(nav);
  registerRotatePublisherCommand(nav);
}
