/** Convert Command - Offline asset/share conversion calculations (no RPC needed) */

import { Command } from "commander";
import { BN } from "@coral-xyz/anchor";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import * as math from "../../../math";

export function registerConvertCommand(program: Command): void {
  program
    .command("convert")
    .description("Offline asset/share conversion (no RPC needed)")
    .requiredOption("-a, --amount <number>", "Amount to convert")
    .requiredOption(
      "-d, --direction <dir>",
      "Direction: to-shares or to-assets",
    )
    .requiredOption("--total-assets <number>", "Current total assets")
    .requiredOption("--total-shares <number>", "Current total shares")
    .requiredOption("--asset-decimals <number>", "Asset decimals (0-9)")
    .action(async (opts) => {
      const globalOpts = getGlobalOptions(program);
      const ctx = await createContext(globalOpts, opts, false, false);
      const { output } = ctx;

      const amount = new BN(opts.amount);
      const totalAssets = new BN(opts.totalAssets);
      const totalShares = new BN(opts.totalShares);
      const assetDecimals = parseInt(opts.assetDecimals);

      if (assetDecimals < 0 || assetDecimals > 9) {
        output.error("Asset decimals must be between 0 and 9");
        process.exit(1);
      }

      const decimalsOffset = math.calculateDecimalsOffset(assetDecimals);

      if (opts.direction === "to-shares") {
        const shares = math.convertToShares(
          amount,
          totalAssets,
          totalShares,
          decimalsOffset,
        );

        if (globalOpts.output === "json") {
          output.json({
            direction: "to-shares",
            input: amount.toString(),
            output: shares.toString(),
            totalAssets: totalAssets.toString(),
            totalShares: totalShares.toString(),
            decimalsOffset,
          });
        } else {
          output.success(
            `${amount.toString()} assets = ${shares.toString()} shares`,
          );
        }
      } else if (opts.direction === "to-assets") {
        const assets = math.convertToAssets(
          amount,
          totalAssets,
          totalShares,
          decimalsOffset,
        );

        if (globalOpts.output === "json") {
          output.json({
            direction: "to-assets",
            input: amount.toString(),
            output: assets.toString(),
            totalAssets: totalAssets.toString(),
            totalShares: totalShares.toString(),
            decimalsOffset,
          });
        } else {
          output.success(
            `${amount.toString()} shares = ${assets.toString()} assets`,
          );
        }
      } else {
        output.error("Direction must be 'to-shares' or 'to-assets'");
        process.exit(1);
      }
    });
}
