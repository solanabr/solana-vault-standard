import { Command } from "commander";
import { registerRequestDepositCommand } from "./request-deposit";
import { registerApproveDepositCommand } from "./approve-deposit";
import { registerClaimDepositCommand } from "./claim-deposit";
import { registerRejectDepositCommand } from "./reject-deposit";
import { registerCancelDepositCommand } from "./cancel-deposit";
import { registerRequestRedeemCommand } from "./request-redeem";
import { registerApproveRedeemCommand } from "./approve-redeem";
import { registerClaimRedeemCommand } from "./claim-redeem";
import { registerCancelRedeemCommand } from "./cancel-redeem";
import { registerRepayCommand } from "./repay";
import { registerDrawDownCommand } from "./draw-down";
import { registerFreezeAccountCommand } from "./freeze-account";
import { registerUnfreezeAccountCommand } from "./unfreeze-account";
import { registerInvestmentWindowCommand } from "./investment-window";

export function registerCreditCommands(program: Command): void {
  registerRequestDepositCommand(program);
  registerApproveDepositCommand(program);
  registerClaimDepositCommand(program);
  registerRejectDepositCommand(program);
  registerCancelDepositCommand(program);
  registerRequestRedeemCommand(program);
  registerApproveRedeemCommand(program);
  registerClaimRedeemCommand(program);
  registerCancelRedeemCommand(program);
  registerRepayCommand(program);
  registerDrawDownCommand(program);
  registerFreezeAccountCommand(program);
  registerUnfreezeAccountCommand(program);
  registerInvestmentWindowCommand(program);
}
