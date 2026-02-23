const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const EXPECTED_NETWORK = "amoy";
const ORDER_CREATION_FEE_UNITS = process.env.ORDER_CREATION_FEE || "1";
const TOKEN_DISTRIBUTION_UNITS = process.env.AMOY_TOKEN_DISTRIBUTION_UNITS || "50000";
const FEE_TOKEN_6_DECIMALS = 6;
const FEE_TOKEN_6_DISTRIBUTION_UNITS = process.env.AMOY_TOKEN6_DISTRIBUTION_UNITS || "50000";

const DEPLOY_GAS_LIMIT = 15_000_000;
const ERC20_TX_GAS_LIMIT = 750_000;

function parseRecipients(rawValue, deployerAddress) {
  const recipients = new Set([deployerAddress.toLowerCase()]);
  if (!rawValue) {
    return [...recipients];
  }

  for (const entry of rawValue.split(",")) {
    const candidate = entry.trim();
    if (!candidate) continue;
    if (!hre.ethers.isAddress(candidate)) {
      throw new Error(`Invalid recipient address in AMOY_FUND_RECIPIENTS: ${candidate}`);
    }
    recipients.add(candidate.toLowerCase());
  }

  return [...recipients];
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

async function deployToken(name, symbol) {
  const TestToken = await hre.ethers.getContractFactory("TestToken");
  const token = await TestToken.deploy(name, symbol, { gasLimit: DEPLOY_GAS_LIMIT });
  await token.waitForDeployment();
  return token;
}

async function deployTokenWithDecimals(name, symbol, decimals) {
  const TestTokenDecimals = await hre.ethers.getContractFactory("TestTokenDecimals");
  const token = await TestTokenDecimals.deploy(name, symbol, decimals, { gasLimit: DEPLOY_GAS_LIMIT });
  await token.waitForDeployment();
  return token;
}

async function main() {
  if (hre.network.name !== EXPECTED_NETWORK) {
    throw new Error(
      `Refusing to run on ${hre.network.name}. Use --network ${EXPECTED_NETWORK} for this script.`
    );
  }

  const [deployer] = await hre.ethers.getSigners();
  const { chainId } = await hre.ethers.provider.getNetwork();
  const deployerAddress = await deployer.getAddress();
  const deployerBalanceWei = await hre.ethers.provider.getBalance(deployerAddress);
  const recipients = parseRecipients(process.env.AMOY_FUND_RECIPIENTS, deployerAddress);

  console.log(`Network: ${hre.network.name} (${chainId})`);
  console.log(`Deployer: ${deployerAddress}`);
  console.log(`Deployer balance: ${hre.ethers.formatEther(deployerBalanceWei)} MATIC`);
  console.log(`Funding recipients: ${recipients.join(", ")}`);

  const feeToken = await deployToken("Amoy Fee Token", "LFT");
  const feeToken6 = await deployTokenWithDecimals("Amoy Fee Token 6", "LF6", FEE_TOKEN_6_DECIMALS);
  const tokenA = await deployToken("Amoy Token A", "LTKA");
  const tokenB = await deployToken("Amoy Token B", "LTKB");

  const feeTokenAddress = await feeToken.getAddress();
  const feeToken6Address = await feeToken6.getAddress();
  const tokenAAddress = await tokenA.getAddress();
  const tokenBAddress = await tokenB.getAddress();

  const orderFee = hre.ethers.parseUnits(ORDER_CREATION_FEE_UNITS, 18);
  const distributionAmount = hre.ethers.parseUnits(TOKEN_DISTRIBUTION_UNITS, 18);
  const distributionAmount6 = hre.ethers.parseUnits(
    FEE_TOKEN_6_DISTRIBUTION_UNITS,
    FEE_TOKEN_6_DECIMALS
  );

  const allowedTokens = [feeTokenAddress, feeToken6Address, tokenAAddress, tokenBAddress];
  const WhaleSwap = await hre.ethers.getContractFactory("WhaleSwap");
  const whaleSwap = await WhaleSwap.deploy(feeTokenAddress, orderFee, allowedTokens, {
    gasLimit: DEPLOY_GAS_LIMIT
  });
  await whaleSwap.waitForDeployment();
  const whaleSwapAddress = await whaleSwap.getAddress();

  for (const recipient of recipients) {
    if (recipient !== deployerAddress.toLowerCase()) {
      await (
        await feeToken.transfer(recipient, distributionAmount, { gasLimit: ERC20_TX_GAS_LIMIT })
      ).wait();
      await (
        await tokenA.transfer(recipient, distributionAmount, { gasLimit: ERC20_TX_GAS_LIMIT })
      ).wait();
      await (
        await tokenB.transfer(recipient, distributionAmount, { gasLimit: ERC20_TX_GAS_LIMIT })
      ).wait();
    }

    await (
      await feeToken6.mint(recipient, distributionAmount6, { gasLimit: ERC20_TX_GAS_LIMIT })
    ).wait();
  }

  const deployment = {
    generatedAt: new Date().toISOString(),
    network: {
      name: hre.network.name,
      chainId: Number(chainId)
    },
    deployer: deployerAddress,
    orderCreationFee: ORDER_CREATION_FEE_UNITS,
    orderCreationFeeWei: orderFee.toString(),
    contracts: {
      whaleSwap: whaleSwapAddress,
      feeToken: feeTokenAddress,
      feeToken6: feeToken6Address,
      tokenA: tokenAAddress,
      tokenB: tokenBAddress,
      allowedTokens
    },
    fundedAccounts: recipients,
    distribution: {
      token18Units: TOKEN_DISTRIBUTION_UNITS,
      token6Units: FEE_TOKEN_6_DISTRIBUTION_UNITS
    }
  };

  const deploymentPath = path.join(__dirname, "..", "deployments", "amoy.test.json");
  writeJson(deploymentPath, deployment);
  console.log(`Wrote deployment details: ${deploymentPath}`);

  console.log("\nAmoy test deployment complete:");
  console.log(`WhaleSwap: ${whaleSwapAddress}`);
  console.log(`LFT:       ${feeTokenAddress}`);
  console.log(`LF6:       ${feeToken6Address}`);
  console.log(`LTKA:      ${tokenAAddress}`);
  console.log(`LTKB:      ${tokenBAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
