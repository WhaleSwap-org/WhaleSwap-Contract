# OTC Swap Smart Contract (General-Purpose)

A secure and efficient smart contract for peer-to-peer token swaps, enabling users to create, fill, and manage OTC (Over-The-Counter) token swap orders with optional counterparty restriction.

## Features

- Peer-to-peer ERC20 token swaps
- Optional counterparty restriction (set a specific taker or open to anyone)
- Order creation fee (configurable by owner)
- Token allowlist (owner-managed)
- OpenZeppelin standard compliance

## Security Features

- Reentrancy protection
- SafeERC20 implementation
- Input validation
- Access control
- Arithmetic overflow protection

## Prerequisites

- Node.js >= 14.0.0
- npm >= 6.0.0
- Hardhat

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/otc-swap-contract.git
cd otc-swap-contract
```

2. Install dependencies:
```bash
npm install
```

3. Compile contracts:
```bash
npx hardhat compile
```

4. Run tests:
```bash
npx hardhat test
```

## Contract Overview

The OTC Swap contract enables users to:

1. Create swap orders specifying:
    - Sell token and amount
    - Buy token and amount
    - Optional specific counterparty (taker)

2. Fill existing orders
3. Cancel orders
4. Query order details and status (via `orders(orderId)`)

### Core Functions

```solidity
function createOrder(
    address taker,
    address sellToken,
    uint256 sellAmount,
    address buyToken,
    uint256 buyAmount
) external returns (uint256)

function fillOrder(uint256 orderId) external

function cancelOrder(uint256 orderId) external

function updateAllowedTokens(address[] tokens, bool[] allowed) external
function getAllowedTokens() external view returns (address[] memory)
function updateFeeConfig(address feeToken, uint256 feeAmount) external
```

## Usage Example

```javascript
// Create an order
const sellAmount = ethers.parseEther('100');
const buyAmount = ethers.parseEther('200');
await tokenA.approve(otcSwap.address, sellAmount);
const orderId = await otcSwap.createOrder(
    ethers.ZeroAddress,  // Allow any counterparty
    tokenA.address,      // Sell token
    sellAmount,          // Sell amount
    tokenB.address,      // Buy token
    buyAmount           // Buy amount
);

// Fill an order
await tokenB.approve(otcSwap.address, buyAmount);
await otcSwap.fillOrder(orderId);
```

## Testing

The contract includes a comprehensive test suite covering:

- Basic functionality
- Edge cases
- Security scenarios
- Malicious token attacks

Run tests with coverage:
```bash
npx hardhat coverage
```

## Deployment

1. Set up your environment variables:
```bash
cp .env.example .env
# Edit .env with your configuration
```

2. Install deps / compile:
```bash
npm ci
npx hardhat compile
```

3. Deploy to a specific network (one network per run):
```bash
npx hardhat run scripts/deploy.js --network <network-name>
```

### Required Environment Variables

`scripts/deploy.js` requires:

- `PRIVATE_KEY`
- `FEE_TOKEN_DECIMALS`
- `ORDER_CREATION_FEE`
- Fee token address for the selected network:
  - `POLYGON_FEE_TOKEN_ADDRESS` (for `--network polygon`)
  - `BSC_FEE_TOKEN_ADDRESS` (for `--network bsc`)
  - `AMOY_FEE_TOKEN_ADDRESS` (for `--network amoy`)

Hardhat network RPC URLs are configured in `hardhat.config.js`:

- `POLYGON_RPC_URL`
- `BSC_RPC_URL`
- `AMOY_RPC_URL`

### Allowlist (Per Network)

The deploy script loads a per-network allowlist file by default:

- `allowed-tokens.<network>.json` (e.g. `allowed-tokens.polygon.json`, `allowed-tokens.bsc.json`)

You can override the allowlist path via:

- `POLYGON_ALLOWED_TOKENS_PATH` (for `--network polygon`)
- `BSC_ALLOWED_TOKENS_PATH` (for `--network bsc`)
- `AMOY_ALLOWED_TOKENS_PATH` (for `--network amoy`)

### Verification

Automatic verification is attempted at the end of `scripts/deploy.js` when deploying to:

- `polygon`
- `bsc`
- `amoy`

Explorer API key (recommended):

- `ETHERSCAN_API_KEY`

If you prefer, you can set:

- `POLYGONSCAN_API_KEY`
- `BSCSCAN_API_KEY`

Manual verification examples:

```bash
# BSC (example)
npx hardhat verify --network bsc --constructor-args scripts/verify-args-bsc.js <DEPLOYED_ADDRESS>

# Polygon (example)
npx hardhat verify --network polygon --constructor-args scripts/verify-args-polygon.js <DEPLOYED_ADDRESS>
```

## Architecture

### Order Structure
```solidity
struct Order {
    address maker;
    address taker;       // Optional specific counterparty (address(0) = open)
    address sellToken;
    uint256 sellAmount;
    address buyToken;
    uint256 buyAmount;
    uint256 timestamp;
    OrderStatus status;
    address feeToken;
    uint256 orderCreationFee;
    uint256 tries;
}
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Security

This contract has not been audited. Use at your own risk.

If you discover any security issues, please contact us instead of using the issue tracker.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- OpenZeppelin for their secure contract implementations
- Hardhat for the development environment
- The Ethereum community for best practices and standards
