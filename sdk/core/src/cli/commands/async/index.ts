import { Command } from "commander";
import { registerRequestDepositCommand } from "./request-deposit";
import { registerCancelDepositCommand } from "./cancel-deposit";
import { registerFulfillDepositCommand } from "./fulfill-deposit";
import { registerClaimDepositCommand } from "./claim-deposit";
import { registerRequestRedeemCommand } from "./request-redeem";
import { registerCancelRedeemCommand } from "./cancel-redeem";
import { registerFulfillRedeemCommand } from "./fulfill-redeem";
import { registerClaimRedeemCommand } from "./claim-redeem";
import { registerSetOperatorCommand } from "./set-operator";

export function registerAsyncCommands(program: Command): void {
  registerRequestDepositCommand(program);
  registerCancelDepositCommand(program);
  registerFulfillDepositCommand(program);
  registerClaimDepositCommand(program);
  registerRequestRedeemCommand(program);
  registerCancelRedeemCommand(program);
  registerFulfillRedeemCommand(program);
  registerClaimRedeemCommand(program);
  registerSetOperatorCommand(program);
}
