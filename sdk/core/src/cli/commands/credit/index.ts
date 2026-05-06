import { Command } from "commander";
import { registerBootstrapSharesComplianceCommand } from "./bootstrap-shares-compliance";
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
import { registerSetOracleSourceCommand } from "./set-oracle-source";

export function registerCreditCommands(program: Command): void {
  // Pool setup (operator runbook). bootstrap-shares-compliance runs
  // ONCE per pool, after `credit init` (initialize_pool), to wire up
  // the cPOOL hook PDAs. Listed first to mirror the operator workflow
  // order in `docs/SVS-11.md::Pool Setup`.
  registerBootstrapSharesComplianceCommand(program);

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
  registerSetOracleSourceCommand(program);
}
