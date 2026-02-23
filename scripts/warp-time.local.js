const hre = require("hardhat");

const LOCAL_CHAIN_IDS = new Set([1337, 31337]);

function parseWarpToSeconds(input) {
  if (!input) return null;

  const raw = String(input).trim().toLowerCase();
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }

  const match = raw.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return null;

  const value = Number(match[1]);
  const unit = match[2];
  const multipliers = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60,
  };
  return value * multipliers[unit];
}

function getRequestedWarpSeconds() {
  // Supports either:
  // - npm run warp:local -- 7d
  // - WARP=7d npm run warp:local
  const cliArg = process.argv.slice(2).find((v) => !String(v).startsWith("--"));
  const candidate = cliArg || process.env.WARP || "1h";
  const parsed = parseWarpToSeconds(candidate);
  if (parsed === null || parsed <= 0) {
    throw new Error(
      `Invalid warp value "${candidate}". Use raw seconds or suffix format like 30m, 2h, 7d.`
    );
  }
  return { seconds: parsed, label: candidate };
}

async function main() {
  const { chainId } = await hre.ethers.provider.getNetwork();
  if (!LOCAL_CHAIN_IDS.has(Number(chainId))) {
    throw new Error(`Refusing to warp non-local chainId ${chainId}.`);
  }

  const before = await hre.ethers.provider.getBlock("latest");
  const { seconds, label } = getRequestedWarpSeconds();

  await hre.network.provider.send("evm_increaseTime", [seconds]);
  await hre.network.provider.send("evm_mine");

  const after = await hre.ethers.provider.getBlock("latest");
  const delta = Number(after.timestamp) - Number(before.timestamp);

  console.log(`Warped chain time by ${delta} seconds (requested: ${label}).`);
  console.log(`Before: ${before.timestamp}`);
  console.log(`After:  ${after.timestamp}`);
  console.log(`Block:  ${after.number}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
