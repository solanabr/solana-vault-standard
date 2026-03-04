/**
 * CLI Middleware Module
 *
 * Composable middleware chain for CLI command execution.
 * Handles config loading, connection setup, wallet loading, and error handling.
 *
 * Middleware order matters:
 * 1. errorMiddleware - Catch and format errors
 * 2. configMiddleware - Load/merge configuration
 * 3. outputMiddleware - Setup output adapter
 * 4. connectionMiddleware - Setup RPC connection
 * 5. walletMiddleware - Load wallet keypair
 */

import { CliContext, MiddlewareFunction, GlobalOptions } from "../types";
import { loadConfig, applyGlobalOptions } from "../config";
import { createOutputAdapter } from "../output";
import { setupConnection } from "./connection";
import { loadWallet } from "./wallet";

/**
 * Execute a chain of middleware functions.
 *
 * @param middlewares - Array of middleware functions
 * @param initialCtx - Initial context (partially populated)
 * @param finalAction - Action to run after all middleware
 */
export async function runMiddleware(
  middlewares: MiddlewareFunction[],
  initialCtx: Partial<CliContext>,
  finalAction: (ctx: CliContext) => Promise<void>,
): Promise<void> {
  let index = 0;

  const next = async (): Promise<void> => {
    if (index < middlewares.length) {
      const middleware = middlewares[index++];
      await middleware(initialCtx, next);
    } else {
      await finalAction(initialCtx as CliContext);
    }
  };

  await next();
}

/**
 * Create a fully populated CLI context for command execution.
 *
 * @param globalOpts - Parsed global options from CLI
 * @param commandOpts - Command-specific options
 * @param requiresConnection - Whether to setup RPC connection
 * @param requiresWallet - Whether to load wallet keypair
 * @returns Fully populated CLI context
 */
export async function createContext(
  globalOpts: GlobalOptions,
  commandOpts: Record<string, unknown> = {},
  requiresConnection = true,
  requiresWallet = true,
): Promise<CliContext> {
  const options: GlobalOptions = {
    ...globalOpts,
    ...(commandOpts as Partial<GlobalOptions>),
  };

  let config = loadConfig();
  config = applyGlobalOptions(config, options);

  const output = createOutputAdapter(
    options.output || config.defaults.output,
    options.verbose || false,
    options.quiet || false,
  );

  const ctx: Partial<CliContext> = {
    config,
    options,
    output,
  };

  if (requiresConnection) {
    const url = options.url || getRpcUrl(config.defaults.cluster);
    const { connection, provider } = await setupConnection(
      url,
      config.defaults.confirmation,
      requiresWallet ? options.keypair || config.defaults.keypair : undefined,
    );
    ctx.connection = connection;
    ctx.provider = provider;
  }

  if (requiresWallet && options.keypair !== undefined) {
    ctx.wallet = loadWallet(options.keypair || config.defaults.keypair);
  } else if (requiresWallet) {
    ctx.wallet = loadWallet(config.defaults.keypair);
  }

  return ctx as CliContext;
}

/** Get default RPC URL for a cluster name */
function getRpcUrl(cluster: string): string {
  switch (cluster) {
    case "mainnet-beta":
      return "https://api.mainnet-beta.solana.com";
    case "testnet":
      return "https://api.testnet.solana.com";
    case "localnet":
      return "http://localhost:8899";
    case "devnet":
    default:
      return "https://api.devnet.solana.com";
  }
}

/** Middleware: Load and apply configuration */
export const configMiddleware: MiddlewareFunction = async (ctx, next) => {
  if (!ctx.config) {
    ctx.config = loadConfig();
    if (ctx.options?.profile) {
      ctx.config = applyGlobalOptions(ctx.config, ctx.options);
    }
  }
  await next();
};

/** Middleware: Setup output adapter */
export const outputMiddleware: MiddlewareFunction = async (ctx, next) => {
  if (!ctx.output) {
    ctx.output = createOutputAdapter(
      ctx.options?.output || ctx.config?.defaults.output || "table",
      ctx.options?.verbose || false,
      ctx.options?.quiet || false,
    );
  }
  await next();
};

/** Middleware: Setup RPC connection and provider */
export const connectionMiddleware: MiddlewareFunction = async (ctx, next) => {
  if (!ctx.connection) {
    const url =
      ctx.options?.url || getRpcUrl(ctx.config?.defaults.cluster || "devnet");
    const { connection, provider } = await setupConnection(
      url,
      ctx.config?.defaults.confirmation || "confirmed",
      ctx.wallet
        ? undefined
        : ctx.options?.keypair || ctx.config?.defaults.keypair,
    );
    ctx.connection = connection;
    ctx.provider = provider;
  }
  await next();
};

/** Middleware: Load wallet keypair */
export const walletMiddleware: MiddlewareFunction = async (ctx, next) => {
  if (!ctx.wallet) {
    const keypairPath =
      ctx.options?.keypair ||
      ctx.config?.defaults.keypair ||
      "~/.config/solana/id.json";
    ctx.wallet = loadWallet(keypairPath);
  }
  await next();
};

/** Middleware: Catch and format errors */
export const errorMiddleware: MiddlewareFunction = async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    if (ctx.output) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.output.error(message);
      if (ctx.options?.verbose && error instanceof Error && error.stack) {
        console.error(error.stack);
      }
    } else {
      console.error(error);
    }
    process.exit(1);
  }
};

/** Standard middleware stack: error handling, config, output */
export const standardMiddleware: MiddlewareFunction[] = [
  errorMiddleware,
  configMiddleware,
  outputMiddleware,
];

/** Connected middleware stack: standard + RPC connection */
export const connectedMiddleware: MiddlewareFunction[] = [
  ...standardMiddleware,
  connectionMiddleware,
];

/** Full middleware stack: connected + wallet */
export const fullMiddleware: MiddlewareFunction[] = [
  ...connectedMiddleware,
  walletMiddleware,
];
