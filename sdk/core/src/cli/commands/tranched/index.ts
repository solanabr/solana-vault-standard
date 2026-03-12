import { Command } from "commander";
import { registerTranchedInitializeCommand } from "./initialize";
import { registerTranchedAddTrancheCommand } from "./add-tranche";
import { registerTranchedDepositCommand } from "./deposit";
import { registerTranchedRedeemCommand } from "./redeem";
import { registerTranchedDistributeYieldCommand } from "./distribute-yield";
import { registerTranchedRecordLossCommand } from "./record-loss";
import { registerTranchedRebalanceCommand } from "./rebalance";
import { registerTranchedAdminCommand } from "./admin";
import { registerTranchedInfoCommand } from "./info";

export function registerTranchedCommands(program: Command): void {
  const tranched = program
    .command("tranched")
    .description("SVS-12 Tranched Vault commands");

  registerTranchedInitializeCommand(tranched);
  registerTranchedAddTrancheCommand(tranched);
  registerTranchedDepositCommand(tranched);
  registerTranchedRedeemCommand(tranched);
  registerTranchedDistributeYieldCommand(tranched);
  registerTranchedRecordLossCommand(tranched);
  registerTranchedRebalanceCommand(tranched);
  registerTranchedAdminCommand(tranched);
  registerTranchedInfoCommand(tranched);
}
