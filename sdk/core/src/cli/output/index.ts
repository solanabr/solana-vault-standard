/**
 * CLI Output Module
 *
 * Provides formatted output adapters for consistent CLI display.
 * Supports multiple output formats (table, JSON, CSV) and respects
 * quiet/verbose modes for scripting and debugging.
 */

import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import Table from "cli-table3";
import { OutputAdapter, OutputFormat, Spinner } from "../types";

/**
 * Create an output adapter with the specified format and verbosity.
 *
 * @param format - Output format: "table", "json", or "csv"
 * @param verbose - Enable debug output
 * @param quiet - Suppress non-essential output (for scripts)
 * @returns Configured output adapter
 */
export function createOutputAdapter(
  format: OutputFormat = "table",
  verbose = false,
  quiet = false,
): OutputAdapter {
  return new CliOutputAdapter(format, verbose, quiet);
}

class CliOutputAdapter implements OutputAdapter {
  format: OutputFormat;
  verbose: boolean;
  quiet: boolean;

  constructor(format: OutputFormat, verbose: boolean, quiet: boolean) {
    this.format = format;
    this.verbose = verbose;
    this.quiet = quiet;
  }

  table(headers: string[], rows: string[][]): void {
    if (this.quiet) return;

    switch (this.format) {
      case "json":
        this.json(
          rows.map((row) =>
            Object.fromEntries(headers.map((h, i) => [h, row[i]])),
          ),
        );
        break;
      case "csv":
        this.csv(headers, rows);
        break;
      default:
        const table = new Table({
          head: headers.map((h) => chalk.cyan(h)),
          style: { head: [], border: [] },
        });
        rows.forEach((row) => table.push(row));
        console.log(table.toString());
    }
  }

  json(data: unknown): void {
    console.log(JSON.stringify(data, null, 2));
  }

  csv(headers: string[], rows: string[][]): void {
    const escape = (val: string): string => {
      if (val.includes(",") || val.includes('"') || val.includes("\n")) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    };

    console.log(headers.map(escape).join(","));
    rows.forEach((row) => console.log(row.map(escape).join(",")));
  }

  success(message: string): void {
    if (this.quiet) return;
    if (this.format === "json") {
      console.log(JSON.stringify({ status: "success", message }));
    } else {
      console.log(chalk.green("✓") + " " + message);
    }
  }

  error(message: string): void {
    if (this.format === "json") {
      console.error(JSON.stringify({ status: "error", message }));
    } else {
      console.error(chalk.red("✗") + " " + message);
    }
  }

  warn(message: string): void {
    if (this.quiet) return;
    if (this.format === "json") {
      console.log(JSON.stringify({ status: "warning", message }));
    } else {
      console.log(chalk.yellow("⚠") + " " + message);
    }
  }

  info(message: string): void {
    if (this.quiet) return;
    if (this.format === "json") {
      console.log(JSON.stringify({ status: "info", message }));
    } else {
      console.log(chalk.blue("ℹ") + " " + message);
    }
  }

  debug(message: string): void {
    if (!this.verbose) return;
    if (this.format === "json") {
      console.log(JSON.stringify({ status: "debug", message }));
    } else {
      console.log(chalk.gray("  " + message));
    }
  }

  spinner(message: string): Spinner {
    if (this.quiet || this.format === "json") {
      return new NoOpSpinner();
    }
    return ora(message) as Spinner;
  }

  async confirm(message: string): Promise<boolean> {
    if (this.format === "json") {
      return true;
    }

    const { confirmed } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmed",
        message,
        default: false,
      },
    ]);

    return confirmed;
  }
}

/** No-op spinner for quiet mode or JSON output */
class NoOpSpinner implements Spinner {
  text = "";
  start(): Spinner {
    return this;
  }
  stop(): Spinner {
    return this;
  }
  succeed(): Spinner {
    return this;
  }
  fail(): Spinner {
    return this;
  }
}

/**
 * Format a token amount with decimal places.
 *
 * @param amount - Raw token amount
 * @param decimals - Token decimals
 * @returns Formatted string (e.g., "1000000" with 6 decimals → "1")
 */
export function formatAmount(
  amount: bigint | number | string,
  decimals: number,
): string {
  const str = amount.toString().padStart(decimals + 1, "0");
  const intPart = str.slice(0, str.length - decimals) || "0";
  const decPart = str.slice(str.length - decimals);
  const trimmedDec = decPart.replace(/0+$/, "");
  return trimmedDec ? `${intPart}.${trimmedDec}` : intPart;
}

/**
 * Format a Solana address, optionally truncating for display.
 *
 * @param address - Base58 address string
 * @param truncate - If true, show as "Abc1...xyz9"
 */
export function formatAddress(address: string, truncate = true): string {
  if (!truncate || address.length <= 12) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

/**
 * Format a Unix timestamp or Date to ISO string.
 */
export function formatTimestamp(timestamp: number | Date): string {
  const date =
    typeof timestamp === "number" ? new Date(timestamp * 1000) : timestamp;
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");
}

/**
 * Format a decimal value as percentage.
 *
 * @param value - Decimal value (0.05 = 5%)
 * @param decimals - Decimal places in output
 */
export function formatPercentage(value: number, decimals = 2): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

/**
 * Format basis points as "X bps (Y%)".
 */
export function formatBps(bps: number): string {
  return `${bps} bps (${(bps / 100).toFixed(2)}%)`;
}
