# WhaleSwap Local Development Setup

This guide covers:
- Adding the local Hardhat network to MetaMask
- Running local WhaleSwap contracts
- Running the WhaleSwap UI against local contracts

## 1. Prerequisites

- Node.js installed
- MetaMask installed in your browser
- Both repos present locally:
  - `whaleswap-contract`
  - `whaleswap-ui`

## 2. Install Dependencies

Contract repo:

```bash
cd whaleswap-contract
npm install
```

UI repo:

```bash
cd whaleswap-ui
npm install
```

## 3. Start Local Hardhat Node

```bash
cd whaleswap-contract
npm run node
```

Keep this terminal open. It prints funded local accounts and private keys.

## 4. Add Hardhat Network in MetaMask

In MetaMask, open **Add a custom network** and enter:

- Network Name: `Hardhat Local`
- New RPC URL: `http://127.0.0.1:8545`
- Chain ID: `1337`
- Currency Symbol: `ETH`
- Block Explorer URL: optional (can leave blank)

Save.

## 5. Import a Hardhat Account in MetaMask

From the `npm run node` output, copy one private key (for example Account #0).

In MetaMask:
- Account menu -> **Import account**
- Paste the private key

This gives you a funded local account for testing.

## 6. Deploy Local Contracts + Test Tokens

In a second terminal:

```bash
cd whaleswap-contract
npm run deploy:local
```

This script deploys:
- `WhaleSwap` contract
- Fee token (`LFT`, 18 decimals)
- Alternate fee token (`LF6`, 6 decimals)
- Two tradable test tokens (`LTKA`, `LTKB`)

It also updates:
- `whaleswap-contract/deployments/local.json`
- `whaleswap-ui/js/local-dev.deployment.js`
- `whaleswap-ui/js/abi/OTCSwap.js`

## 7. Start the UI

In a third terminal:

```bash
cd whaleswap-ui
npm start
```

Open:

`http://127.0.0.1:8080/?chain=local`

Notes:
- Local network option is shown only on localhost hosts.
- If UI shows wrong/missing local contract address, rerun `npm run deploy:local`.

## 8. Day-to-Day Startup Order

Every fresh local session:

1. Start node: `npm run node` (contract repo)
2. Deploy local stack: `npm run deploy:local` (contract repo)
3. Start UI: `npm start` (UI repo)
4. Open `http://127.0.0.1:8080/?chain=local`

## 9. Common Issues

### `Artifact for contract "OTCSwap" not found`

Use the latest local deploy script from this branch. It deploys `WhaleSwap`.

### MetaMask on wrong network

Switch MetaMask to the custom network with chain ID `1337`.

### New addresses after restart

If you restart the Hardhat node, addresses can reset. Run `npm run deploy:local` again.
