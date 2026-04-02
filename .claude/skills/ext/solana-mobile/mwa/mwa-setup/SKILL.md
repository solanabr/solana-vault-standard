---
name: mwa-setup
description: Set up Mobile Wallet Adapter dependencies, crypto polyfills, and providers in a React Native Expo app. Use when the user needs to install MWA packages, configure polyfills, set up MobileWalletProvider, or prepare their app for wallet integration.
---

# MWA Setup

Install dependencies, configure crypto polyfills, and set up providers for Mobile Wallet Adapter.

## When to Use

- User wants to add MWA to a fresh React Native project
- Project is missing MWA dependencies or providers
- Crypto polyfill errors ("crypto.getRandomValues() not supported")

## When NOT to Use

- Project already has MWA set up (check for `MobileWalletProvider` in layout)
- User just wants to add a connect button → Use `mwa-connection` instead
- User just wants transactions → Use `mwa-transactions` instead

## Prerequisites

- React Native Expo project
- **NOT using Expo Go** (requires development build)
- Android development environment

## Implementation

### Step 1: Install Dependencies

```bash
npm install @wallet-ui/react-native-web3js @solana/web3.js @tanstack/react-query react-native-get-random-values
```

### Step 2: Crypto Polyfill (CRITICAL)

**The crypto polyfill MUST be the VERY FIRST import in the app entry point.**

**Expo Router** (`app/_layout.tsx`):
```typescript
import 'react-native-get-random-values'; // MUST BE FIRST

import { Stack } from 'expo-router';
// ... other imports
```

**React Navigation** (`index.tsx`):
```typescript
import 'react-native-get-random-values'; // MUST BE FIRST

import '@expo/metro-runtime';
import { registerRootComponent } from 'expo';
// ... other imports
```

**Why**: Other modules check for `crypto` on import. Wrong order = transactions fail silently.

### Step 3: Environment Variables

Create `.env` in project root:
```bash
EXPO_PUBLIC_SOLANA_CLUSTER=devnet
EXPO_PUBLIC_SOLANA_RPC_ENDPOINT=https://api.devnet.solana.com
```

### Step 4: Wallet Constants

Create `constants/wallet.ts`:
```typescript
import type { Chain } from '@solana-mobile/mobile-wallet-adapter-protocol';

export const APP_IDENTITY = {
  name: 'Your App Name',
  uri: 'https://yourapp.com',
  icon: 'favicon.ico',
};

export const SOLANA_CLUSTER = (
  process.env.EXPO_PUBLIC_SOLANA_CLUSTER || 'devnet'
) as 'devnet' | 'testnet' | 'mainnet-beta';

export const SOLANA_CHAIN: Chain = `solana:${SOLANA_CLUSTER}`;

export const SOLANA_RPC_ENDPOINT =
  process.env.EXPO_PUBLIC_SOLANA_RPC_ENDPOINT ||
  'https://api.devnet.solana.com';
```

### Step 5: Configure Provider

Wrap app with `MobileWalletProvider`:

**Expo Router** (`app/_layout.tsx`):
```typescript
import 'react-native-get-random-values'; // FIRST

import { Stack } from 'expo-router';
import { MobileWalletProvider } from '@wallet-ui/react-native-web3js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { APP_IDENTITY, SOLANA_CHAIN, SOLANA_RPC_ENDPOINT } from '@/constants/wallet';

const queryClient = new QueryClient();

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <MobileWalletProvider
        chain={SOLANA_CHAIN}
        endpoint={SOLANA_RPC_ENDPOINT}
        identity={APP_IDENTITY}
      >
        <Stack />
      </MobileWalletProvider>
    </QueryClientProvider>
  );
}
```

### Step 6: Build Development Build

```bash
npx expo prebuild --clean
npx expo run:android
```

**Required** because MWA uses native Android modules not included in Expo Go.

## Troubleshooting

### "Secure context (https)" Error

```
SolanaMobileWalletAdapterError: The mobile wallet adapter protocol must be used in a secure context (`https`).
```

**Fix**: Remove ESM folder to force native resolution:
```bash
rm -rf node_modules/@solana-mobile/mobile-wallet-adapter-protocol/lib/esm
npx expo run:android
```

## Next Steps

After setup is complete:
- Add wallet connection → Use `mwa-connection` skill
- Add transactions → Use `mwa-transactions` skill
