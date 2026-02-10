const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function verifyContract(address, args, maxRetries = 3) {
  let retryCount = 0;
  
  while (retryCount < maxRetries) {
    try {
      console.log(`Verification attempt ${retryCount + 1}/${maxRetries}...`);
      
      await hre.run("verify:verify", {
        address: address,
        constructorArguments: args,
      });
      
      console.log("✅ Contract verified successfully");
      return true;
      
    } catch (error) {
      if (error.message.includes("Already Verified")) {
        console.log("✅ Contract already verified");
        return true;
      } else if (error.message.includes("does not have bytecode") || 
                 error.message.includes("Bytecode not found") ||
                 error.message.includes("Contract source code not verified")) {
        retryCount++;
        if (retryCount < maxRetries) {
          const waitTime = retryCount * 30; // Exponential backoff: 30s, 60s, 90s
          console.log(`❌ Verification failed (bytecode not ready). Waiting ${waitTime} seconds before retry...`);
          console.log("Error:", error.message);
          await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
        } else {
          console.error("❌ Max retries reached. Verification failed:", error.message);
          console.log("💡 Try running verification manually later with:");
          console.log(`npx hardhat verify --network polygon ${address} "${args[0]}" "${args[1]}" '${JSON.stringify(args[2])}'`);
          return false;
        }
      } else {
        console.error("❌ Verification failed with unexpected error:", error.message);
        return false;
      }
    }
  }
  
  return false;
}

async function main() {
  // Fee config: default to 1 USDC (6 decimals) unless overridden by env.
  const FEE_TOKEN_DECIMALS = Number(process.env.FEE_TOKEN_DECIMALS || "6");
  const ORDER_CREATION_FEE = process.env.ORDER_CREATION_FEE || "1";

  // Network-specific fee token addresses can be set via env:
  // - POLYGON_FEE_TOKEN_ADDRESS
  // - BSC_FEE_TOKEN_ADDRESS
  // Fallbacks are common USDC addresses.
  const POLYGON_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
  const BSC_USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";

  const feeTokenAddressByNetwork = {
    polygon: process.env.POLYGON_FEE_TOKEN_ADDRESS || POLYGON_USDC,
    bsc: process.env.BSC_FEE_TOKEN_ADDRESS || BSC_USDC,
  };

  const feeTokenAddress =
    feeTokenAddressByNetwork[network.name] || process.env.FEE_TOKEN_ADDRESS;

  if (!feeTokenAddress) {
    throw new Error(
      `Missing fee token address for network ${network.name}. Set FEE_TOKEN_ADDRESS (or POLYGON_FEE_TOKEN_ADDRESS / BSC_FEE_TOKEN_ADDRESS).`
    );
  }

  const FEE_AMOUNT = ethers.parseUnits(ORDER_CREATION_FEE, FEE_TOKEN_DECIMALS);
  
  // Load allowed tokens from a per-network JSON file.
  // Priority:
  // 1) <NETWORK>_ALLOWED_TOKENS_PATH (POLYGON_..., BSC_...)
  // 2) ALLOWED_TOKENS_PATH
  // 3) allowed-tokens.<network>.json (if present)
  // 4) allowed-tokens.json
  const networkEnvPrefixByName = {
    polygon: "POLYGON",
    bsc: "BSC",
  };
  const networkEnvPrefix = networkEnvPrefixByName[network.name] || network.name.toUpperCase();
  const perNetworkEnvKey = `${networkEnvPrefix}_ALLOWED_TOKENS_PATH`;

  const perNetworkDefaultFile = `allowed-tokens.${network.name}.json`;
  const perNetworkDefaultPath = path.join(__dirname, "..", perNetworkDefaultFile);

  const allowedTokensPath = path.join(
    __dirname,
    "..",
    process.env[perNetworkEnvKey] ||
      process.env.ALLOWED_TOKENS_PATH ||
      (fs.existsSync(perNetworkDefaultPath) ? perNetworkDefaultFile : "allowed-tokens.json")
  );
  let ALLOWED_TOKENS;
  
  try {
    const allowedTokensData = fs.readFileSync(allowedTokensPath, "utf8");
    ALLOWED_TOKENS = JSON.parse(allowedTokensData);
    console.log(`Loaded ${ALLOWED_TOKENS.length} allowed tokens from ${allowedTokensPath}`);
  } catch (error) {
    console.error("Error loading allowed tokens file:", error.message);
    throw error;
  }

  // Optional safety: ensure the fee token is tradable (i.e., in the allowlist).
  if (!ALLOWED_TOKENS.some((a) => String(a).toLowerCase() === feeTokenAddress.toLowerCase())) {
    console.warn(
      `Fee token ${feeTokenAddress} is not in the allowlist file (${allowedTokensPath}). Adding it for deployment.`
    );
    ALLOWED_TOKENS.push(feeTokenAddress);
  }

  console.log("Deploying OTCSwap contract...");
  console.log("Network:", network.name);

  const [deployer] = await ethers.getSigners();
  console.log("Deploying from:", deployer.address);

  const OTCSwap = await ethers.getContractFactory("OTCSwap");
  const otcSwap = await OTCSwap.deploy(feeTokenAddress, FEE_AMOUNT, ALLOWED_TOKENS);

  await otcSwap.waitForDeployment();
  const address = await otcSwap.getAddress();

  console.log({
    address,
    feeToken: feeTokenAddress,
    feeAmount: ORDER_CREATION_FEE,
    feeTokenDecimals: FEE_TOKEN_DECIMALS,
    allowedTokens: ALLOWED_TOKENS
  });

  if (network.name === "polygon" || network.name === "mumbai" || network.name === "amoy" || network.name === "bsc") {
    console.log("\n🔍 Starting contract verification process...");
    console.log("⏳ Waiting for block confirmations (this may take a few minutes)...");
    
    // Wait for more confirmations to ensure the contract is properly indexed
    const confirmations = network.name === "polygon" ? 10 : 5;
    await otcSwap.deploymentTransaction().wait(confirmations);
    console.log(`✅ ${confirmations} confirmations received`);
    
    // Additional wait time for Polygon explorer to index the contract
    console.log("⏳ Waiting additional 60 seconds for explorer to index the contract...");
    await new Promise(resolve => setTimeout(resolve, 60000));
    
    console.log("🚀 Starting verification...");
    const verificationSuccess = await verifyContract(address, [feeTokenAddress, FEE_AMOUNT, ALLOWED_TOKENS]);
    
    if (!verificationSuccess) {
      console.log("\n📝 Manual verification command:");
      console.log(`npx hardhat verify --network ${network.name} ${address} "${feeTokenAddress}" "${FEE_AMOUNT}" '${JSON.stringify(ALLOWED_TOKENS)}'`);
    }
  } else {
    console.log("ℹ️  Skipping verification (not on a supported network)");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
