const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function verifyContract(networkName, address, args, maxRetries = 3) {
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
          console.log(`npx hardhat verify --network ${networkName} ${address} "${args[0]}" "${args[1]}" '${JSON.stringify(args[2])}'`);
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

function getRequiredEnv(key) {
  const val = process.env[key];
  if (val === undefined || String(val).trim() === "") {
    throw new Error(`Missing required env var: ${key}`);
  }
  return val;
}

function resolvePathFromProject(p) {
  // Allow absolute paths; otherwise resolve relative to project root.
  if (path.isAbsolute(p)) return p;
  return path.join(__dirname, "..", p);
}

async function main() {
  const ORDER_CREATION_FEE = getRequiredEnv("ORDER_CREATION_FEE");

  const feeTokenEnvKeyByNetwork = {
    polygon: "POLYGON_FEE_TOKEN_ADDRESS",
    bsc: "BSC_FEE_TOKEN_ADDRESS",
    amoy: "AMOY_FEE_TOKEN_ADDRESS",
  };
  const feeDecimalsEnvKeyByNetwork = {
    polygon: "POLYGON_FEE_TOKEN_DECIMALS",
    bsc: "BSC_FEE_TOKEN_DECIMALS",
    amoy: "AMOY_FEE_TOKEN_DECIMALS",
  };
  const feeTokenEnvKey = feeTokenEnvKeyByNetwork[network.name];
  const feeDecimalsEnvKey = feeDecimalsEnvKeyByNetwork[network.name];
  if (!feeTokenEnvKey) {
    throw new Error(
      `Unsupported network ${network.name}. Add fee token env key mapping for this network.`
    );
  }
  if (!feeDecimalsEnvKey) {
    throw new Error(
      `Unsupported network ${network.name}. Add fee decimals env key mapping for this network.`
    );
  }
  const feeTokenAddress = getRequiredEnv(feeTokenEnvKey);
  const FEE_TOKEN_DECIMALS_RAW = getRequiredEnv(feeDecimalsEnvKey);
  const FEE_TOKEN_DECIMALS = Number(FEE_TOKEN_DECIMALS_RAW);
  if (!Number.isInteger(FEE_TOKEN_DECIMALS) || FEE_TOKEN_DECIMALS < 0 || FEE_TOKEN_DECIMALS > 255) {
    throw new Error(
      `Invalid ${feeDecimalsEnvKey}=${JSON.stringify(FEE_TOKEN_DECIMALS_RAW)} (expected integer 0..255)`
    );
  }

  let FEE_AMOUNT;
  try {
    FEE_AMOUNT = ethers.parseUnits(ORDER_CREATION_FEE, FEE_TOKEN_DECIMALS);
  } catch (e) {
    throw new Error(
      `Invalid ORDER_CREATION_FEE=${JSON.stringify(ORDER_CREATION_FEE)} or ${feeDecimalsEnvKey}=${FEE_TOKEN_DECIMALS}: ${e.message}`
    );
  }
  
  // Allowlist config: prefer explicit per-network env var; otherwise use the committed
  // `allowed-tokens.<network>.json`. Do NOT fall back to a shared allowlist file.
  const allowlistEnvKeyByNetwork = {
    polygon: "POLYGON_ALLOWED_TOKENS_PATH",
    bsc: "BSC_ALLOWED_TOKENS_PATH",
    amoy: "AMOY_ALLOWED_TOKENS_PATH",
  };
  const allowlistEnvKey = allowlistEnvKeyByNetwork[network.name];
  if (!allowlistEnvKey) {
    throw new Error(
      `Unsupported network ${network.name}. Add allowlist env key mapping for this network.`
    );
  }

  const defaultAllowlistFile = `allowed-tokens.${network.name}.json`;
  const allowlistPathRaw = process.env[allowlistEnvKey] || defaultAllowlistFile;
  const allowedTokensPath = resolvePathFromProject(allowlistPathRaw);
  let ALLOWED_TOKENS;
  
  try {
    const allowedTokensData = fs.readFileSync(allowedTokensPath, "utf8");
    ALLOWED_TOKENS = JSON.parse(allowedTokensData);
    console.log(`Loaded ${ALLOWED_TOKENS.length} allowed tokens from ${allowedTokensPath}`);
  } catch (error) {
    console.error("Error loading allowed tokens file:", error.message);
    throw error;
  }

  // Safety: fee token must be tradable (i.e., in the allowlist).
  if (!ALLOWED_TOKENS.some((a) => String(a).toLowerCase() === feeTokenAddress.toLowerCase())) {
    throw new Error(
      `Fee token ${feeTokenAddress} is not in the allowlist file (${allowedTokensPath}). Add it to the allowlist (or fix ${feeTokenEnvKey}).`
    );
  }

  console.log("Deploying WhaleSwap contract...");
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
    const verificationSuccess = await verifyContract(network.name, address, [feeTokenAddress, FEE_AMOUNT, ALLOWED_TOKENS]);
    
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
