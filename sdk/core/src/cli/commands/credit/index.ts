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
import { registerInvestmentWindowCommand } from "./investment-window";
import { registerRejectRedeemCommand } from "./reject-redeem";
import { registerSetOracleCommand } from "./set-oracle";
import { registerUpdateOracleParamsCommand } from "./update-oracle-params";
import { registerAuthorityCommands } from "./authority";

export function registerCreditCommands(program: Command): void {
  const credit = program
    .command("credit")
    .description("SVS-11 Credit Vault commands");

  // Pool setup (operator runbook). bootstrap-shares-compliance runs
  // ONCE per pool, after `credit init` (initialize_pool), to wire up
  // the cPOOL hook PDAs. Listed first to mirror the operator workflow
  // order in `docs/SVS-11.md::Pool Setup`.
  registerBootstrapSharesComplianceCommand(credit);

  registerRequestDepositCommand(credit);
  registerApproveDepositCommand(credit);
  registerClaimDepositCommand(credit);
  registerRejectDepositCommand(credit);
  registerCancelDepositCommand(credit);
  registerRequestRedeemCommand(credit);
  registerApproveRedeemCommand(credit);
  registerClaimRedeemCommand(credit);
  registerCancelRedeemCommand(credit);
  registerRejectRedeemCommand(credit);
  registerRepayCommand(credit);
  registerDrawDownCommand(credit);
  registerInvestmentWindowCommand(credit);

  // Admin: pluggable-oracle repoint + staleness window + two-step authority rotation.
  registerSetOracleCommand(credit);
  registerUpdateOracleParamsCommand(credit);
  registerAuthorityCommands(credit);
}
