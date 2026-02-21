const { expect } = require('chai')
const { ethers, network } = require('hardhat')
const fs = require('fs')

const DAY = 24 * 60 * 60

async function advanceAfterExpiryAndGrace() {
  await ethers.provider.send('evm_increaseTime', [14 * DAY + 1])
  await ethers.provider.send('evm_mine', [])
}

async function hasTrackedOrderForMaker(otcSwap, maker) {
  const nextOrderId = await otcSwap.nextOrderId()
  for (let i = 0n; i < nextOrderId; i = i + 1n) {
    const order = await otcSwap.orders(i)
    if (order.maker.toLowerCase() === maker.toLowerCase()) {
      return true
    }
  }
  return false
}

describe('OTCSwap - Security Regressions (Expected Failing Until Fix)', function () {
  const ORDER_FEE = ethers.parseUnits('100', 18)
  const SELL_AMOUNT = ethers.parseEther('10')
  const BUY_AMOUNT = ethers.parseEther('20')

  it('should never allow filling an order that was already expired before cleanup retry', async function () {
    const [owner, maker, taker, cleaner] = await ethers.getSigners()

    const TestToken = await ethers.getContractFactory('TestToken')
    const buyToken = await TestToken.deploy('Buy', 'BUY')
    await buyToken.waitForDeployment()
    const feeToken = await TestToken.deploy('Fee', 'FEE')
    await feeToken.waitForDeployment()

    const MisbehavingToken = await ethers.getContractFactory('MisbehavingToken')
    const sellToken = await MisbehavingToken.deploy()
    await sellToken.waitForDeployment()

    const OTCSwap = await ethers.getContractFactory('OTCSwap')
    const otcSwap = await OTCSwap.deploy(feeToken.target, ORDER_FEE, [
      sellToken.target,
      buyToken.target,
      feeToken.target,
    ])
    await otcSwap.waitForDeployment()

    await sellToken.transfer(maker.address, SELL_AMOUNT)
    await buyToken.transfer(taker.address, BUY_AMOUNT)
    await feeToken.transfer(maker.address, ORDER_FEE * 10n)

    await sellToken.connect(maker).approve(otcSwap.target, SELL_AMOUNT)
    await feeToken.connect(maker).approve(otcSwap.target, ORDER_FEE * 10n)
    await otcSwap
      .connect(maker)
      .createOrder(ethers.ZeroAddress, sellToken.target, SELL_AMOUNT, buyToken.target, BUY_AMOUNT)

    await advanceAfterExpiryAndGrace()
    await sellToken.connect(owner).pause()
    await otcSwap.connect(cleaner).cleanupExpiredOrders()
    await sellToken.connect(owner).unpause()

    await buyToken.connect(taker).approve(otcSwap.target, BUY_AMOUNT)

    const nextOrderId = await otcSwap.nextOrderId()
    if (nextOrderId > 1n) {
      await expect(otcSwap.connect(taker).fillOrder(nextOrderId - 1n)).to.be.reverted
    } else {
      await expect(otcSwap.connect(taker).fillOrder(0)).to.be.reverted
    }
  })

  it('should not orphan maker principal after max cleanup retries', async function () {
    const [owner, maker, cleaner] = await ethers.getSigners()

    const TestToken = await ethers.getContractFactory('TestToken')
    const buyToken = await TestToken.deploy('Buy', 'BUY')
    await buyToken.waitForDeployment()
    const feeToken = await TestToken.deploy('Fee', 'FEE')
    await feeToken.waitForDeployment()

    const MisbehavingToken = await ethers.getContractFactory('MisbehavingToken')
    const sellToken = await MisbehavingToken.deploy()
    await sellToken.waitForDeployment()

    const OTCSwap = await ethers.getContractFactory('OTCSwap')
    const otcSwap = await OTCSwap.deploy(feeToken.target, ORDER_FEE, [
      sellToken.target,
      buyToken.target,
      feeToken.target,
    ])
    await otcSwap.waitForDeployment()

    await sellToken.transfer(maker.address, SELL_AMOUNT)
    await feeToken.transfer(maker.address, ORDER_FEE * 10n)

    await sellToken.connect(maker).approve(otcSwap.target, SELL_AMOUNT)
    await feeToken.connect(maker).approve(otcSwap.target, ORDER_FEE * 10n)
    await otcSwap
      .connect(maker)
      .createOrder(ethers.ZeroAddress, sellToken.target, SELL_AMOUNT, buyToken.target, BUY_AMOUNT)

    await sellToken.connect(owner).pause()

    for (let i = 0; i < 11; i++) {
      await advanceAfterExpiryAndGrace()
      await expect(otcSwap.connect(cleaner).cleanupExpiredOrders()).to.not.be.reverted
    }

    const makerRecoveredPrincipal = (await sellToken.balanceOf(maker.address)) > 0n
    const orderStillRecoverable = await hasTrackedOrderForMaker(otcSwap, maker.address)

    expect(makerRecoveredPrincipal || orderStillRecoverable).to.equal(true)
  })

  it('should not mark cleanup as successful when token reports transfer true but moves nothing', async function () {
    const [owner, maker, cleaner] = await ethers.getSigners()

    const TestToken = await ethers.getContractFactory('TestToken')
    const buyToken = await TestToken.deploy('Buy', 'BUY')
    await buyToken.waitForDeployment()
    const feeToken = await TestToken.deploy('Fee', 'FEE')
    await feeToken.waitForDeployment()

    const PhantomTransferToken = await ethers.getContractFactory('PhantomTransferToken')
    const sellToken = await PhantomTransferToken.deploy('Phantom Sell', 'PSELL')
    await sellToken.waitForDeployment()

    const OTCSwap = await ethers.getContractFactory('OTCSwap')
    const otcSwap = await OTCSwap.deploy(feeToken.target, ORDER_FEE, [
      sellToken.target,
      buyToken.target,
      feeToken.target,
    ])
    await otcSwap.waitForDeployment()

    await sellToken.transfer(maker.address, SELL_AMOUNT)
    await feeToken.transfer(maker.address, ORDER_FEE * 10n)

    await sellToken.connect(maker).approve(otcSwap.target, SELL_AMOUNT)
    await feeToken.connect(maker).approve(otcSwap.target, ORDER_FEE * 10n)
    await otcSwap
      .connect(maker)
      .createOrder(ethers.ZeroAddress, sellToken.target, SELL_AMOUNT, buyToken.target, BUY_AMOUNT)

    await advanceAfterExpiryAndGrace()

    const makerBefore = await sellToken.balanceOf(maker.address)
    const cleanerBefore = await feeToken.balanceOf(cleaner.address)

    await sellToken.connect(owner).setPhantomTransfersEnabled(true)
    await expect(otcSwap.connect(cleaner).cleanupExpiredOrders()).to.not.be.reverted

    const makerAfter = await sellToken.balanceOf(maker.address)
    const cleanerAfter = await feeToken.balanceOf(cleaner.address)
    const makerRecoveredPrincipal = makerAfter - makerBefore === SELL_AMOUNT
    const cleanerPaid = cleanerAfter > cleanerBefore
    const orderStillRecoverable = await hasTrackedOrderForMaker(otcSwap, maker.address)

    expect(makerRecoveredPrincipal || (!cleanerPaid && orderStillRecoverable)).to.equal(true)
  })

  it('should not let fees in token B mask insolvency in token A during cleanup payout', async function () {
    const [owner, makerA, makerB, cleaner] = await ethers.getSigners()

    const TestToken = await ethers.getContractFactory('TestToken')
    const sellToken = await TestToken.deploy('Sell', 'SELL')
    await sellToken.waitForDeployment()
    const buyToken = await TestToken.deploy('Buy', 'BUY')
    await buyToken.waitForDeployment()
    const feeTokenB = await TestToken.deploy('Fee B', 'FEEB')
    await feeTokenB.waitForDeployment()

    const DeflationaryFeeToken = await ethers.getContractFactory('DeflationaryFeeToken')
    const feeTokenA = await DeflationaryFeeToken.deploy('Fee A', 'FEEA')
    await feeTokenA.waitForDeployment()

    const OTCSwap = await ethers.getContractFactory('OTCSwap')
    const otcSwap = await OTCSwap.deploy(feeTokenA.target, ORDER_FEE, [
      sellToken.target,
      buyToken.target,
      feeTokenA.target,
      feeTokenB.target,
    ])
    await otcSwap.waitForDeployment()

    await sellToken.transfer(makerA.address, SELL_AMOUNT)
    await sellToken.transfer(makerB.address, SELL_AMOUNT)
    await feeTokenA.transfer(makerA.address, ORDER_FEE * 2n)
    await feeTokenB.transfer(makerB.address, ORDER_FEE)

    await sellToken.connect(makerA).approve(otcSwap.target, SELL_AMOUNT)
    await feeTokenA.connect(makerA).approve(otcSwap.target, ORDER_FEE)
    await otcSwap
      .connect(makerA)
      .createOrder(ethers.ZeroAddress, sellToken.target, SELL_AMOUNT, buyToken.target, BUY_AMOUNT)
    await otcSwap.connect(makerA).cancelOrder(0)

    await otcSwap.connect(owner).updateFeeConfig(feeTokenB.target, ORDER_FEE)

    await sellToken.connect(makerB).approve(otcSwap.target, SELL_AMOUNT)
    await feeTokenB.connect(makerB).approve(otcSwap.target, ORDER_FEE)
    await otcSwap
      .connect(makerB)
      .createOrder(ethers.ZeroAddress, sellToken.target, SELL_AMOUNT, buyToken.target, BUY_AMOUNT)
    await otcSwap.connect(makerB).cancelOrder(1)

    expect(await otcSwap.accumulatedFees()).to.equal(ORDER_FEE * 2n)
    expect(await feeTokenA.balanceOf(otcSwap.target)).to.equal(ORDER_FEE / 2n)
    expect(await feeTokenB.balanceOf(otcSwap.target)).to.equal(ORDER_FEE)

    await advanceAfterExpiryAndGrace()

    await expect(otcSwap.connect(cleaner).cleanupExpiredOrders()).to.not.be.reverted
  })

  it('should cleanup legacy no-return transfer tokens without retry loops or principal loss', async function () {
    const [maker, cleaner] = await ethers.getSigners()

    const TestToken = await ethers.getContractFactory('TestToken')
    const buyToken = await TestToken.deploy('Buy', 'BUY')
    await buyToken.waitForDeployment()
    const feeToken = await TestToken.deploy('Fee', 'FEE')
    await feeToken.waitForDeployment()

    const NoReturnToken = await ethers.getContractFactory('NoReturnToken')
    const sellToken = await NoReturnToken.deploy('Legacy', 'LEG')
    await sellToken.waitForDeployment()

    const OTCSwap = await ethers.getContractFactory('OTCSwap')
    const otcSwap = await OTCSwap.deploy(feeToken.target, ORDER_FEE, [
      sellToken.target,
      buyToken.target,
      feeToken.target,
    ])
    await otcSwap.waitForDeployment()

    await sellToken.transfer(maker.address, SELL_AMOUNT)
    await feeToken.transfer(maker.address, ORDER_FEE * 10n)

    await sellToken.connect(maker).approve(otcSwap.target, SELL_AMOUNT)
    await feeToken.connect(maker).approve(otcSwap.target, ORDER_FEE * 10n)
    await otcSwap
      .connect(maker)
      .createOrder(ethers.ZeroAddress, sellToken.target, SELL_AMOUNT, buyToken.target, BUY_AMOUNT)

    await advanceAfterExpiryAndGrace()

    const makerBefore = await sellToken.balanceOf(maker.address)
    await expect(otcSwap.connect(cleaner).cleanupExpiredOrders()).to.not.be.reverted
    const makerAfter = await sellToken.balanceOf(maker.address)
    const hasResidualOrder = await hasTrackedOrderForMaker(otcSwap, maker.address)

    expect(makerAfter - makerBefore).to.equal(SELL_AMOUNT)
    expect(hasResidualOrder).to.equal(false)
  })

  it('should allow maker to cancel active orders after grace to recover principal directly', async function () {
    const [maker] = await ethers.getSigners()

    const TestToken = await ethers.getContractFactory('TestToken')
    const sellToken = await TestToken.deploy('Sell', 'SELL')
    await sellToken.waitForDeployment()
    const buyToken = await TestToken.deploy('Buy', 'BUY')
    await buyToken.waitForDeployment()
    const feeToken = await TestToken.deploy('Fee', 'FEE')
    await feeToken.waitForDeployment()

    const OTCSwap = await ethers.getContractFactory('OTCSwap')
    const otcSwap = await OTCSwap.deploy(feeToken.target, ORDER_FEE, [
      sellToken.target,
      buyToken.target,
      feeToken.target,
    ])
    await otcSwap.waitForDeployment()

    await sellToken.transfer(maker.address, SELL_AMOUNT)
    await feeToken.transfer(maker.address, ORDER_FEE * 10n)

    await sellToken.connect(maker).approve(otcSwap.target, SELL_AMOUNT)
    await feeToken.connect(maker).approve(otcSwap.target, ORDER_FEE * 10n)
    await otcSwap
      .connect(maker)
      .createOrder(ethers.ZeroAddress, sellToken.target, SELL_AMOUNT, buyToken.target, BUY_AMOUNT)

    await advanceAfterExpiryAndGrace()

    const makerBefore = await sellToken.balanceOf(maker.address)
    await expect(otcSwap.connect(maker).cancelOrder(0)).to.not.be.reverted
    const makerAfter = await sellToken.balanceOf(maker.address)

    expect(makerAfter - makerBefore).to.equal(SELL_AMOUNT)
  })

  it('should allow cleanup of expired orders even when queue head is not yet cleanable', async function () {
    const [maker, cleaner] = await ethers.getSigners()

    const TestToken = await ethers.getContractFactory('TestToken')
    const sellToken = await TestToken.deploy('Sell', 'SELL')
    await sellToken.waitForDeployment()
    const buyToken = await TestToken.deploy('Buy', 'BUY')
    await buyToken.waitForDeployment()
    const feeToken = await TestToken.deploy('Fee', 'FEE')
    await feeToken.waitForDeployment()

    const OTCSwap = await ethers.getContractFactory('OTCSwap')
    const otcSwap = await OTCSwap.deploy(feeToken.target, ORDER_FEE, [
      sellToken.target,
      buyToken.target,
      feeToken.target,
    ])
    await otcSwap.waitForDeployment()

    await sellToken.transfer(maker.address, SELL_AMOUNT * 2n)
    await feeToken.transfer(maker.address, ORDER_FEE * 20n)

    await sellToken.connect(maker).approve(otcSwap.target, SELL_AMOUNT * 2n)
    await feeToken.connect(maker).approve(otcSwap.target, ORDER_FEE * 20n)

    await otcSwap
      .connect(maker)
      .createOrder(ethers.ZeroAddress, sellToken.target, SELL_AMOUNT, buyToken.target, BUY_AMOUNT)
    await otcSwap
      .connect(maker)
      .createOrder(ethers.ZeroAddress, sellToken.target, SELL_AMOUNT, buyToken.target, BUY_AMOUNT)

    // Artificially age order #1 while leaving order #0 non-expired to model head-of-line blocking risk.
    const mappingSlot = 8n // storage slot for `orders`
    const key = 1n
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [key, mappingSlot])
    const base = BigInt(ethers.keccak256(encoded))
    const timestampSlot = `0x${(base + 6n).toString(16).padStart(64, '0')}`
    const agedTimestamp = ethers.zeroPadValue('0x01', 32)
    await network.provider.send('hardhat_setStorageAt', [otcSwap.target, timestampSlot, agedTimestamp])
    await ethers.provider.send('evm_mine', [])

    // Even though order #1 is expired, current API can only inspect firstOrderId (#0), so cleanup doesn't reach #1.
    await expect(otcSwap.connect(cleaner).cleanupExpiredOrders()).to.not.be.reverted

    const agedOrder = await otcSwap.orders(1)
    expect(agedOrder.maker).to.equal(ethers.ZeroAddress)
  })

  it('should escrow full sellAmount even when sellToken is fee-on-transfer', async function () {
    const [maker] = await ethers.getSigners()

    const TestToken = await ethers.getContractFactory('TestToken')
    const buyToken = await TestToken.deploy('Buy', 'BUY')
    await buyToken.waitForDeployment()
    const feeToken = await TestToken.deploy('Fee', 'FEE')
    await feeToken.waitForDeployment()

    const DeflationaryFeeToken = await ethers.getContractFactory('DeflationaryFeeToken')
    const sellToken = await DeflationaryFeeToken.deploy('Deflationary Sell', 'DSELL')
    await sellToken.waitForDeployment()

    const OTCSwap = await ethers.getContractFactory('OTCSwap')
    const otcSwap = await OTCSwap.deploy(feeToken.target, ORDER_FEE, [
      sellToken.target,
      buyToken.target,
      feeToken.target,
    ])
    await otcSwap.waitForDeployment()

    // 50% transfer tax: send 2x so maker receives exactly SELL_AMOUNT.
    await sellToken.transfer(maker.address, SELL_AMOUNT * 2n)
    await feeToken.transfer(maker.address, ORDER_FEE * 10n)

    await sellToken.connect(maker).approve(otcSwap.target, SELL_AMOUNT)
    await feeToken.connect(maker).approve(otcSwap.target, ORDER_FEE * 10n)
    await otcSwap
      .connect(maker)
      .createOrder(ethers.ZeroAddress, sellToken.target, SELL_AMOUNT, buyToken.target, BUY_AMOUNT)

    expect(await sellToken.balanceOf(otcSwap.target)).to.equal(SELL_AMOUNT)
  })

  it('should enforce maker receives full buyAmount when buyToken is fee-on-transfer', async function () {
    const [owner, maker, taker] = await ethers.getSigners()

    const TestToken = await ethers.getContractFactory('TestToken')
    const sellToken = await TestToken.deploy('Sell', 'SELL')
    await sellToken.waitForDeployment()
    const feeToken = await TestToken.deploy('Fee', 'FEE')
    await feeToken.waitForDeployment()

    const DeflationaryFeeToken = await ethers.getContractFactory('DeflationaryFeeToken')
    const buyToken = await DeflationaryFeeToken.deploy('Deflationary Buy', 'DBUY')
    await buyToken.waitForDeployment()

    const OTCSwap = await ethers.getContractFactory('OTCSwap')
    const otcSwap = await OTCSwap.deploy(feeToken.target, ORDER_FEE, [
      sellToken.target,
      buyToken.target,
      feeToken.target,
    ])
    await otcSwap.waitForDeployment()

    await sellToken.transfer(maker.address, SELL_AMOUNT)
    // 50% transfer tax: send 2x so taker receives BUY_AMOUNT.
    await buyToken.transfer(taker.address, BUY_AMOUNT * 2n)
    await feeToken.transfer(maker.address, ORDER_FEE * 10n)

    await sellToken.connect(maker).approve(otcSwap.target, SELL_AMOUNT)
    await feeToken.connect(maker).approve(otcSwap.target, ORDER_FEE * 10n)
    await otcSwap
      .connect(maker)
      .createOrder(ethers.ZeroAddress, sellToken.target, SELL_AMOUNT, buyToken.target, BUY_AMOUNT)

    const makerBefore = await buyToken.balanceOf(maker.address)
    await buyToken.connect(taker).approve(otcSwap.target, BUY_AMOUNT)
    await expect(otcSwap.connect(taker).fillOrder(0)).to.not.be.reverted
    const makerAfter = await buyToken.balanceOf(maker.address)

    expect(makerAfter - makerBefore).to.equal(BUY_AMOUNT)
  })

  it('should persist actual taker in order storage when open order is filled', async function () {
    const [maker, taker] = await ethers.getSigners()

    const TestToken = await ethers.getContractFactory('TestToken')
    const sellToken = await TestToken.deploy('Sell', 'SELL')
    await sellToken.waitForDeployment()
    const buyToken = await TestToken.deploy('Buy', 'BUY')
    await buyToken.waitForDeployment()
    const feeToken = await TestToken.deploy('Fee', 'FEE')
    await feeToken.waitForDeployment()

    const OTCSwap = await ethers.getContractFactory('OTCSwap')
    const otcSwap = await OTCSwap.deploy(feeToken.target, ORDER_FEE, [
      sellToken.target,
      buyToken.target,
      feeToken.target,
    ])
    await otcSwap.waitForDeployment()

    await sellToken.transfer(maker.address, SELL_AMOUNT)
    await buyToken.transfer(taker.address, BUY_AMOUNT)
    await feeToken.transfer(maker.address, ORDER_FEE * 10n)

    await sellToken.connect(maker).approve(otcSwap.target, SELL_AMOUNT)
    await feeToken.connect(maker).approve(otcSwap.target, ORDER_FEE * 10n)
    await otcSwap
      .connect(maker)
      .createOrder(ethers.ZeroAddress, sellToken.target, SELL_AMOUNT, buyToken.target, BUY_AMOUNT)

    await buyToken.connect(taker).approve(otcSwap.target, BUY_AMOUNT)
    await otcSwap.connect(taker).fillOrder(0)

    const order = await otcSwap.orders(0)
    expect(order.taker).to.equal(taker.address)
  })

  it('should emit TokenTransferAttempt with the actual cleaned orderId', async function () {
    const [maker, cleaner] = await ethers.getSigners()

    const TestToken = await ethers.getContractFactory('TestToken')
    const sellToken = await TestToken.deploy('Sell', 'SELL')
    await sellToken.waitForDeployment()
    const buyToken = await TestToken.deploy('Buy', 'BUY')
    await buyToken.waitForDeployment()
    const feeToken = await TestToken.deploy('Fee', 'FEE')
    await feeToken.waitForDeployment()

    const OTCSwap = await ethers.getContractFactory('OTCSwap')
    const otcSwap = await OTCSwap.deploy(feeToken.target, ORDER_FEE, [
      sellToken.target,
      buyToken.target,
      feeToken.target,
    ])
    await otcSwap.waitForDeployment()

    await sellToken.transfer(maker.address, SELL_AMOUNT * 2n)
    await feeToken.transfer(maker.address, ORDER_FEE * 20n)

    await sellToken.connect(maker).approve(otcSwap.target, SELL_AMOUNT * 2n)
    await feeToken.connect(maker).approve(otcSwap.target, ORDER_FEE * 20n)

    await otcSwap
      .connect(maker)
      .createOrder(ethers.ZeroAddress, sellToken.target, SELL_AMOUNT, buyToken.target, BUY_AMOUNT)
    await otcSwap.connect(maker).cancelOrder(0)
    await otcSwap
      .connect(maker)
      .createOrder(ethers.ZeroAddress, sellToken.target, SELL_AMOUNT, buyToken.target, BUY_AMOUNT)

    await advanceAfterExpiryAndGrace()

    await expect(otcSwap.connect(cleaner).cleanupExpiredOrders()).to.not.be.reverted
    const tx = await otcSwap.connect(cleaner).cleanupExpiredOrders()
    const receipt = await tx.wait()
    const parsedLogs = receipt.logs
      .map((log) => {
        try {
          return otcSwap.interface.parseLog(log)
        } catch (err) {
          return null
        }
      })
      .filter(Boolean)
    const attemptEvent = parsedLogs.find((evt) => evt.name === 'TokenTransferAttempt')

    expect(attemptEvent).to.not.equal(undefined)
    expect(attemptEvent.args.orderId).to.equal(1n)
  })

  it('should de-duplicate constructor allowlist entries', async function () {
    const TestToken = await ethers.getContractFactory('TestToken')
    const tokenA = await TestToken.deploy('Token A', 'TKA')
    await tokenA.waitForDeployment()
    const tokenB = await TestToken.deploy('Token B', 'TKB')
    await tokenB.waitForDeployment()
    const feeToken = await TestToken.deploy('Fee', 'FEE')
    await feeToken.waitForDeployment()

    const OTCSwap = await ethers.getContractFactory('OTCSwap')
    const otcSwap = await OTCSwap.deploy(feeToken.target, ORDER_FEE, [
      tokenA.target,
      tokenA.target,
      tokenB.target,
    ])
    await otcSwap.waitForDeployment()

    const allowed = await otcSwap.getAllowedTokens()
    const unique = new Set(allowed.map((a) => a.toLowerCase()))
    expect(allowed.length).to.equal(unique.size)
  })

  it('should avoid self-call try/catch transfer architecture in fill path', async function () {
    const source = fs.readFileSync('contracts/OTCSwap.sol', 'utf8')
    expect(source.includes('this.externalTransferFrom(')).to.equal(false)
    expect(source.includes('this.externalTransfer(')).to.equal(false)
    expect(source.includes('function externalTransfer(')).to.equal(false)
    expect(source.includes('function externalTransferFrom(')).to.equal(false)
  })

  it('should not duplicate sell-token allowance precheck in createOrder', async function () {
    const source = fs.readFileSync('contracts/OTCSwap.sol', 'utf8')
    const needle = 'IERC20(sellToken).allowance(msg.sender, address(this)) >= sellAmount'
    const occurrences = source.split(needle).length - 1
    expect(occurrences).to.equal(1)
  })

  it('should enforce a bounded batch size in updateAllowedTokens to avoid gas-limit lockouts', async function () {
    const source = fs.readFileSync('contracts/OTCSwap.sol', 'utf8')
    expect(source.includes('MAX_ALLOWED_TOKENS_BATCH')).to.equal(true)
    expect(source.includes('tokens.length <= MAX_ALLOWED_TOKENS_BATCH')).to.equal(true)
  })
})
