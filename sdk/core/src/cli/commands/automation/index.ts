/** Automation Commands - Guards, autopilot, and batch operations */

import { Command } from "commander";
import { registerGuardCommand } from "./guard";
import { registerAutopilotCommand } from "./autopilot";
import { registerBatchCommand } from "./batch";

export function registerAutomationCommands(program: Command): void {
  registerGuardCommand(program);
  registerAutopilotCommand(program);
  registerBatchCommand(program);
}
