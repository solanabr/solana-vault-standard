/** compliance command group — manage compliance-hook program PDAs */

import { Command } from "commander";
import { registerInitSanctionsListCommand } from "./initialize-sanctions-list";
import { registerUpdateSanctionsListCommand } from "./update-sanctions-list";
import { registerInitMintConfigCommand } from "./initialize-mint-config";
import { registerInitEamlCommand } from "./initialize-eaml";
import { registerFreezeAccountCommand } from "./freeze-account";
import { registerUnfreezeAccountCommand } from "./unfreeze-account";

export function registerComplianceCommands(program: Command): void {
  const compliance = program
    .command("compliance")
    .description(
      "Manage compliance-hook program: SanctionsList, MintConfig, ExtraAccountMetaList",
    );
  registerInitSanctionsListCommand(compliance);
  registerUpdateSanctionsListCommand(compliance);
  registerFreezeAccountCommand(compliance);
  registerUnfreezeAccountCommand(compliance);
  registerInitMintConfigCommand(compliance);
  registerInitEamlCommand(compliance);
}
