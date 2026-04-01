# Frontend Implementation Reference

React Native implementation for .skr domain resolution with Mobile Wallet Adapter integration.

## Framework Note

This reference shows React Native implementation. **For other frontends**, the same pattern applies—you're simply making two API calls to the backend:

- `POST /api/resolve-domain` with `{ domain: "alice.skr" }` → returns `{ address: "..." }`
- `POST /api/resolve-address` with `{ address: "5FHw..." }` → returns `{ domain: "alice.skr" }`

Adapt this to your frontend framework:
- **React (web)**: Use `fetch` or `axios` in a custom hook
- **Vue**: Use composables with `fetch`
- **Svelte**: Use stores or `fetch` in `onMount`
- **Angular**: Use HttpClient in a service
- **Plain JS**: Use `fetch` directly

The core logic is identical—just HTTP POST requests to your backend.

## Domain Resolution Hook

Create a custom hook to handle API calls to the backend:

```typescript
// hooks/use-domain-lookup.ts
import { useState } from 'react';

const API_BASE_URL = 'http://10.0.2.2:3000'; // Android emulator localhost

interface DomainLookupResult {
  address?: string;
  domain?: string;
  error?: string;
}

export function useDomainLookup() {
  const [loading, setLoading] = useState(false);

  /**
   * Resolve .skr domain to wallet address
   * @param domain - Domain name (with or without .skr extension)
   * @returns Wallet address or error
   */
  const resolveDomain = async (domain: string): Promise<DomainLookupResult> => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/resolve-domain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain }),
      });

      if (!response.ok) {
        const error = await response.json();
        return { error: error.error || 'Failed to resolve domain' };
      }

      const data = await response.json();
      return { address: data.address };
    } catch (error) {
      console.error('Error resolving domain:', error);
      return { error: 'Network request failed' };
    } finally {
      setLoading(false);
    }
  };

  /**
   * Reverse lookup: resolve wallet address to .skr domain
   * @param address - Solana wallet address (base58)
   * @returns .skr domain name or error
   */
  const resolveAddress = async (address: string): Promise<DomainLookupResult> => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/resolve-address`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      });

      if (!response.ok) {
        const error = await response.json();
        return { error: error.error || 'Failed to resolve address' };
      }

      const data = await response.json();
      return { domain: data.domain };
    } catch (error) {
      console.error('Error resolving address:', error);
      return { error: 'Network request failed' };
    } finally {
      setLoading(false);
    }
  };

  return {
    resolveDomain,
    resolveAddress,
    loading,
  };
}
```

## Usage in Components

### Example 1: Display User's .skr Domain

```typescript
// app/index.tsx - Main screen showing personalized welcome
import { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { useMobileWalletAdapter } from '@wallet-ui/react-native-web3js';
import { useDomainLookup } from '../hooks/use-domain-lookup';
import { ellipsify } from '../utils/ellipsify';

export default function HomeScreen() {
  const { account } = useMobileWalletAdapter();
  const { resolveAddress, loading } = useDomainLookup();
  const [displayName, setDisplayName] = useState<string>('');

  useEffect(() => {
    if (account?.publicKey) {
      // Try to get user's .skr domain
      resolveAddress(account.publicKey.toBase58()).then((result) => {
        if (result.domain) {
          setDisplayName(result.domain);
        } else {
          // Fallback to truncated address
          setDisplayName(ellipsify(account.publicKey.toBase58()));
        }
      });
    }
  }, [account]);

  return (
    <View>
      {loading ? (
        <Text>Loading...</Text>
      ) : (
        <Text>Welcome, {displayName || 'Guest'}!</Text>
      )}
    </View>
  );
}
```

### Example 2: Domain Search Component

```typescript
// components/domain-search.tsx - Search for domains or addresses
import { useState } from 'react';
import { View, TextInput, Button, Text } from 'react-native';
import { useDomainLookup } from '../hooks/use-domain-lookup';

export function DomainSearch() {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<string>('');
  const { resolveDomain, resolveAddress, loading } = useDomainLookup();

  const handleSearch = async () => {
    if (!query.trim()) return;

    // Check if input looks like a domain (.skr) or address
    if (query.includes('.skr')) {
      // Domain to address lookup
      const res = await resolveDomain(query);
      if (res.address) {
        setResult(`Address: ${res.address}`);
      } else {
        setResult(`Error: ${res.error}`);
      }
    } else {
      // Address to domain lookup
      const res = await resolveAddress(query);
      if (res.domain) {
        setResult(`Domain: ${res.domain}`);
      } else {
        setResult(`Error: ${res.error}`);
      }
    }
  };

  return (
    <View>
      <TextInput
        placeholder="Enter .skr domain or wallet address"
        value={query}
        onChangeText={setQuery}
      />
      <Button title="Search" onPress={handleSearch} disabled={loading} />
      {result && <Text>{result}</Text>}
    </View>
  );
}
```

### Example 3: Display .skr Instead of Address in Lists

```typescript
// components/wallet-list-item.tsx - Show .skr domain in user lists
import { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { useDomainLookup } from '../hooks/use-domain-lookup';
import { ellipsify } from '../utils/ellipsify';

interface WalletListItemProps {
  address: string;
}

export function WalletListItem({ address }: WalletListItemProps) {
  const { resolveAddress } = useDomainLookup();
  const [displayName, setDisplayName] = useState(ellipsify(address));

  useEffect(() => {
    // Try to fetch .skr domain
    resolveAddress(address).then((result) => {
      if (result.domain) {
        setDisplayName(result.domain);
      }
    });
  }, [address]);

  return (
    <View>
      <Text>{displayName}</Text>
    </View>
  );
}
```

## Utility: Address Truncation

```typescript
// utils/ellipsify.ts
export function ellipsify(str: string, len = 4): string {
  if (str.length <= len * 2) return str;
  return `${str.slice(0, len)}...${str.slice(-len)}`;
}
```

## Key Implementation Notes

1. **API URL**: Use `http://10.0.2.2:3000` for Android emulator (maps to host's localhost). For physical devices, use your computer's IP address.

2. **Caching**: Consider caching resolved domains to avoid repeated API calls for the same addresses.

3. **Error Handling**: Always provide fallback to truncated addresses when domain resolution fails.

4. **Loading States**: Show loading indicators during API calls for better UX.

5. **Validation**: The backend validates input, but frontend validation improves UX by catching errors early.

6. **Mobile Wallet Adapter**: Uses `@wallet-ui/react-native-web3js` which provides `useMobileWalletAdapter()` hook with `account`, `connect()`, and `disconnect()` methods.
