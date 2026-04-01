# Wallet Connection Implementation

Complete implementation for wallet connection using Beeman's Wallet UI SDK.

## Basic Connect Button

### Simple Implementation

```typescript
// app/login.tsx
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useMobileWallet } from '@wallet-ui/react-native-web3js';
import { router } from 'expo-router';

export default function LoginScreen() {
  const { account, connect, disconnect } = useMobileWallet();
  const connected = !!account;

  const handleConnect = async () => {
    try {
      const connectedAccount = await connect();
      console.log('Connected:', connectedaccount.address.toString());
      
      // Navigate to main app after connection
      router.replace('/(tabs)');
    } catch (error) {
      console.error('Connection failed:', error);
      // Handle error - show alert to user
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnect();
      console.log('Disconnected');
    } catch (error) {
      console.error('Disconnect failed:', error);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Welcome to Your App</Text>
      
      {!connected ? (
        <Pressable style={styles.button} onPress={handleConnect}>
          <Text style={styles.buttonText}>Connect Wallet</Text>
        </Pressable>
      ) : (
        <View>
          <Text>Connected: {account.address.toString().slice(0, 8)}...</Text>
          <Pressable style={styles.button} onPress={handleDisconnect}>
            <Text style={styles.buttonText}>Disconnect</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 40,
  },
  button: {
    backgroundColor: '#9945FF',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  buttonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
});
```

### Adding to Existing Button

If the app already has a connect button, add MWA connection to it:

```typescript
// Existing button component
import { useMobileWallet } from '@wallet-ui/react-native-web3js';

export function ExistingConnectButton() {
  const { connect } = useMobileWallet();

  const handleConnect = async () => {
    try {
      const account = await connect();
      // Your existing connection logic...
    } catch (error) {
      console.error('MWA connection failed:', error);
    }
  };

  return (
    <Button onPress={handleConnect}>
      Connect with Mobile Wallet
    </Button>
  );
}
```

## Using Wallet State in Components

### Access Connected Account

```typescript
import { useMobileWallet } from '@wallet-ui/react-native-web3js';

export default function ProfileScreen() {
  const { account } = useMobileWallet();
  const connected = !!account;

  if (!connected) {
    return <Text>Please connect your wallet</Text>;
  }

  return (
    <View>
      <Text>Wallet Address:</Text>
      <Text>{account.address.toString()}</Text>
    </View>
  );
}
```

### Protected Routes

```typescript
// app/(tabs)/_layout.tsx
import { useMobileWallet } from '@wallet-ui/react-native-web3js';
import { Redirect } from 'expo-router';

export default function TabsLayout() {
  const { account } = useMobileWallet();

  // Redirect to login if not connected
  if (!account) {
    return <Redirect href="/login" />;
  }

  return (
    <Tabs>
      {/* Your tab screens */}
    </Tabs>
  );
}
```

## Wallet Connection Flow

### 1. User Taps Connect Button
- App calls `connect()` from `useMobileWallet()`
- SDK dispatches intent to wallet apps on device

### 2. User Selects Wallet
- Android shows wallet picker if multiple wallets installed
- User selects their preferred wallet app

### 3. Wallet Shows Approval Dialog
- Wallet displays your app's identity (name, icon, URI)
- User approves or rejects connection
- Wallet may show terms/conditions

### 4. Connection Complete
- If approved: SDK returns `account` object with `publicKey`
- If rejected: Promise rejects with error
- SDK automatically stores auth token for future sessions

## SDK Hook API

### useMobileWallet()

Returns:

```typescript
{
  account: {
    publicKey: PublicKey;
    address: string;
  } | null;
  
  connect: () => Promise<{
    publicKey: PublicKey;
    address: string;
  }>;
  
  disconnect: () => Promise<void>;
  
  signAndSendTransaction: (transaction: Transaction) => Promise<string>;

  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
}
```

### Working with signMessage

The `signMessage` function returns a `Uint8Array`. To convert to base64 for display or storage:

```typescript
const handleSignMessage = async () => {
  const message = new TextEncoder().encode("Hello from MyApp!");
  const signature = await signMessage(message);

  // ⚠️ Buffer doesn't exist in React Native - use btoa instead
  const signatureBase64 = btoa(String.fromCharCode(...signature));

  console.log('Signature:', signatureBase64);
};
```
```

### Key Properties

**account**:
- `null` when not connected
- Object with `publicKey` and `address` when connected
- `publicKey` is a `PublicKey` instance from `@solana/web3.js`
- **Always use `account.address.toString()`** to get the base58 wallet address for display
- Note: `account.address` may not return the expected base58 format - prefer `publicKey.toString()`

**connect()**:
- Initiates wallet connection flow
- Returns account info on success
- Throws error on rejection or failure
- Automatically stores auth token

**disconnect()**:
- Disconnects current session
- Clears stored auth token
- Sets `account` to `null`