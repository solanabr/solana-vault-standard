---
name: mobile-wallet-adapter
description: Integrate Mobile Wallet Adapter (MWA) for wallet connection and transaction signing in React Native Expo apps using Beeman's Wallet UI SDK (@wallet-ui/react-native-web3js). Use when the user requests to add wallet connection, integrate Solana wallet support, add "connect wallet" button, implement transaction signing, send SOL transfers, or set up MWA in their React Native app.
---

# Mobile Wallet Adapter - Router

This is the entry point for MWA integration. **Assess what the user needs, then use the appropriate sub-skill.**

## Quick Assessment

1. **Does the project have MWA set up?** (polyfills, providers, dependencies)
   - If NO → Use `mwa-setup` skill first
   - If YES → Continue to step 2

2. **What does the user want?**
   - Wallet connection (connect/disconnect button) → Use `mwa-connection` skill
   - Send transactions (SOL transfers, signing) → Use `mwa-transactions` skill
   - Both → Do connection first, then transactions

## Sub-Skills

| Skill | When to Use |
|-------|-------------|
| `mwa-setup` | Fresh project needs MWA dependencies, polyfills, providers |
| `mwa-connection` | Add connect/disconnect wallet functionality |
| `mwa-transactions` | Add SOL transfers or transaction signing |

## Prerequisites

- React Native Expo project
- Development build (NOT Expo Go - MWA uses native modules)
- Android development environment

## SDK Used

All sub-skills use `@wallet-ui/react-native-web3js` (Beeman's Wallet UI SDK).
