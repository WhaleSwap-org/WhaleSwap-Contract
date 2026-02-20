const { expect } = require('chai')
const { ethers } = require('hardhat')

const DAY = 24 * 60 * 60

async function advanceAfterExpiryAndGrace() {
  await ethers.provider.send('evm_increaseTime', [14 * DAY + 1])
  await ethers.provider.send('evm_mine', [])
}

function requireFunction(contract, signature) {
  let ok = true
  try {
    contract.interface.getFunction(signature)
  } catch (err) {
    ok = false
  }
  expect(ok, `Missing required function: ${signature}`).to.equal(true)
}

describe('OTCSwap - Spec Compliance Regressions', function () {
  const ORDER_FEE = ethers.parseUnits('100', 18)
  const SELL_AMOUNT = ethers.parseEther('10')
  const BUY_AMOUNT = ethers.parseEther('20')

  it('does not recreate expired orders as fillable on cleanup failure paths', async function () {
    const [owner, maker, taker, cleaner] = await ethers.getSigners()

    const TestToken = await ethers.getContractFactory('TestToken')
    const buyToken = await TestToken.deploy('Buy', 'BUY')
    await buyToken.waitForDeployment()
    const feeToken = await TestToken.deploy('Fee', 'FEE')
    await feeToken.waitForDeployment()

    const MisbehavingToken = await ethers.getContractFactory('MisbehavingToken')
    const sellToken = await MisbehavingToken.deploy()
    await sellToken.waitForDeployment()

    const OTCSwap = await ethers.getContractFactory('WhaleSwap')
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

    await expect(otcSwap.connect(cleaner).cleanupExpiredOrders()).to.not.be.reverted

    // Order 0 should be cleaned and never recreated as a new fillable order.
    expect((await otcSwap.orders(0)).maker).to.equal(ethers.ZeroAddress)
    expect(await otcSwap.nextOrderId()).to.equal(1n)

    await sellToken.connect(owner).unpause()
    await buyToken.connect(taker).approve(otcSwap.target, BUY_AMOUNT)
    await expect(otcSwap.connect(taker).fillOrder(0)).to.be.reverted
  })

  it('tracks fee liabilities per fee token', async function () {
    const [owner, makerA, makerB] = await ethers.getSigners()

    const TestToken = await ethers.getContractFactory('TestToken')
    const sellToken = await TestToken.deploy('Sell', 'SELL')
    await sellToken.waitForDeployment()
    const buyToken = await TestToken.deploy('Buy', 'BUY')
    await buyToken.waitForDeployment()
    const feeTokenA = await TestToken.deploy('Fee A', 'FEEA')
    await feeTokenA.waitForDeployment()
    const feeTokenB = await TestToken.deploy('Fee B', 'FEEB')
    await feeTokenB.waitForDeployment()

    const OTCSwap = await ethers.getContractFactory('WhaleSwap')
    const otcSwap = await OTCSwap.deploy(feeTokenA.target, ORDER_FEE, [
      sellToken.target,
      buyToken.target,
      feeTokenA.target,
      feeTokenB.target,
    ])
    await otcSwap.waitForDeployment()

    requireFunction(otcSwap, 'accumulatedFeesByToken(address)')

    await sellToken.transfer(makerA.address, SELL_AMOUNT)
    await sellToken.transfer(makerB.address, SELL_AMOUNT)
    await feeTokenA.transfer(makerA.address, ORDER_FEE)
    await feeTokenB.transfer(makerB.address, ORDER_FEE)

    await sellToken.connect(makerA).approve(otcSwap.target, SELL_AMOUNT)
    await feeTokenA.connect(makerA).approve(otcSwap.target, ORDER_FEE)
    await otcSwap
      .connect(makerA)
      .createOrder(ethers.ZeroAddress, sellToken.target, SELL_AMOUNT, buyToken.target, BUY_AMOUNT)

    await otcSwap.connect(owner).updateFeeConfig(feeTokenB.target, ORDER_FEE)

    await sellToken.connect(makerB).approve(otcSwap.target, SELL_AMOUNT)
    await feeTokenB.connect(makerB).approve(otcSwap.target, ORDER_FEE)
    await otcSwap
      .connect(makerB)
      .createOrder(ethers.ZeroAddress, sellToken.target, SELL_AMOUNT, buyToken.target, BUY_AMOUNT)

    expect(await otcSwap.accumulatedFeesByToken(feeTokenA.target)).to.equal(ORDER_FEE)
    expect(await otcSwap.accumulatedFeesByToken(feeTokenB.target)).to.equal(ORDER_FEE)
  })

  it('cancel credits maker claimable balance even when transfer token is paused', async function () {
    const [owner, maker] = await ethers.getSigners()

    const TestToken = await ethers.getContractFactory('TestToken')
    const buyToken = await TestToken.deploy('Buy', 'BUY')
    await buyToken.waitForDeployment()
    const feeToken = await TestToken.deploy('Fee', 'FEE')
    await feeToken.waitForDeployment()

    const MisbehavingToken = await ethers.getContractFactory('MisbehavingToken')
    const sellToken = await MisbehavingToken.deploy()
    await sellToken.waitForDeployment()

    const OTCSwap = await ethers.getContractFactory('WhaleSwap')
    const otcSwap = await OTCSwap.deploy(feeToken.target, ORDER_FEE, [
      sellToken.target,
      buyToken.target,
      feeToken.target,
    ])
    await otcSwap.waitForDeployment()

    requireFunction(otcSwap, 'claimable(address,address)')

    await sellToken.transfer(maker.address, SELL_AMOUNT)
    await feeToken.transfer(maker.address, ORDER_FEE * 10n)
    await sellToken.connect(maker).approve(otcSwap.target, SELL_AMOUNT)
    await feeToken.connect(maker).approve(otcSwap.target, ORDER_FEE * 10n)
    await otcSwap
      .connect(maker)
      .createOrder(ethers.ZeroAddress, sellToken.target, SELL_AMOUNT, buyToken.target, BUY_AMOUNT)

    await sellToken.connect(owner).pause()
    await expect(otcSwap.connect(maker).cancelOrder(0)).to.not.be.reverted
    expect(await otcSwap.claimable(maker.address, sellToken.target)).to.equal(SELL_AMOUNT)
  })

  it('cleanup credits maker and cleaner claimables without inline transfers', async function () {
    const [owner, maker, cleaner] = await ethers.getSigners()

    const TestToken = await ethers.getContractFactory('TestToken')
    const buyToken = await TestToken.deploy('Buy', 'BUY')
    await buyToken.waitForDeployment()
    const feeToken = await TestToken.deploy('Fee', 'FEE')
    await feeToken.waitForDeployment()

    const MisbehavingToken = await ethers.getContractFactory('MisbehavingToken')
    const sellToken = await MisbehavingToken.deploy()
    await sellToken.waitForDeployment()

    const OTCSwap = await ethers.getContractFactory('WhaleSwap')
    const otcSwap = await OTCSwap.deploy(feeToken.target, ORDER_FEE, [
      sellToken.target,
      buyToken.target,
      feeToken.target,
    ])
    await otcSwap.waitForDeployment()

    requireFunction(otcSwap, 'claimable(address,address)')

    await sellToken.transfer(maker.address, SELL_AMOUNT)
    await feeToken.transfer(maker.address, ORDER_FEE * 10n)
    await sellToken.connect(maker).approve(otcSwap.target, SELL_AMOUNT)
    await feeToken.connect(maker).approve(otcSwap.target, ORDER_FEE * 10n)
    await otcSwap
      .connect(maker)
      .createOrder(ethers.ZeroAddress, sellToken.target, SELL_AMOUNT, buyToken.target, BUY_AMOUNT)

    await advanceAfterExpiryAndGrace()
    await sellToken.connect(owner).pause()
    await expect(otcSwap.connect(cleaner).cleanupExpiredOrders()).to.not.be.reverted

    expect((await otcSwap.orders(0)).maker).to.equal(ethers.ZeroAddress)
    expect(await otcSwap.claimable(maker.address, sellToken.target)).to.equal(SELL_AMOUNT)
    expect(await otcSwap.claimable(cleaner.address, feeToken.target)).to.equal(ORDER_FEE)
  })

  it('supports claimable token discovery and removes token when withdrawn to zero', async function () {
    const [maker] = await ethers.getSigners()

    const TestToken = await ethers.getContractFactory('TestToken')
    const sellToken = await TestToken.deploy('Sell', 'SELL')
    await sellToken.waitForDeployment()
    const buyToken = await TestToken.deploy('Buy', 'BUY')
    await buyToken.waitForDeployment()
    const feeToken = await TestToken.deploy('Fee', 'FEE')
    await feeToken.waitForDeployment()

    const OTCSwap = await ethers.getContractFactory('WhaleSwap')
    const otcSwap = await OTCSwap.deploy(feeToken.target, ORDER_FEE, [
      sellToken.target,
      buyToken.target,
      feeToken.target,
    ])
    await otcSwap.waitForDeployment()

    requireFunction(otcSwap, 'claimable(address,address)')
    requireFunction(otcSwap, 'getClaimableTokens(address)')
    requireFunction(otcSwap, 'withdraw(address,uint256)')

    await sellToken.transfer(maker.address, SELL_AMOUNT)
    await feeToken.transfer(maker.address, ORDER_FEE * 10n)
    await sellToken.connect(maker).approve(otcSwap.target, SELL_AMOUNT)
    await feeToken.connect(maker).approve(otcSwap.target, ORDER_FEE * 10n)
    await otcSwap
      .connect(maker)
      .createOrder(ethers.ZeroAddress, sellToken.target, SELL_AMOUNT, buyToken.target, BUY_AMOUNT)

    await otcSwap.connect(maker).cancelOrder(0)
    expect(await otcSwap.claimable(maker.address, sellToken.target)).to.equal(SELL_AMOUNT)

    const beforeList = await otcSwap.getClaimableTokens(maker.address)
    expect(beforeList.map((a) => a.toLowerCase())).to.include(sellToken.target.toLowerCase())

    await expect(otcSwap.connect(maker).withdraw(sellToken.target, SELL_AMOUNT)).to.not.be.reverted
    expect(await otcSwap.claimable(maker.address, sellToken.target)).to.equal(0n)

    const afterList = await otcSwap.getClaimableTokens(maker.address)
    expect(afterList.map((a) => a.toLowerCase())).to.not.include(sellToken.target.toLowerCase())
  })

  it('exposes both withdrawAll overloads and enforces atomic batch behavior', async function () {
    const [owner, maker] = await ethers.getSigners()

    const TestToken = await ethers.getContractFactory('TestToken')
    const sellTokenA = await TestToken.deploy('Sell A', 'SELA')
    await sellTokenA.waitForDeployment()
    const buyToken = await TestToken.deploy('Buy', 'BUY')
    await buyToken.waitForDeployment()
    const feeToken = await TestToken.deploy('Fee', 'FEE')
    await feeToken.waitForDeployment()
    const MisbehavingToken = await ethers.getContractFactory('MisbehavingToken')
    const sellTokenB = await MisbehavingToken.deploy()
    await sellTokenB.waitForDeployment()

    const OTCSwap = await ethers.getContractFactory('WhaleSwap')
    const otcSwap = await OTCSwap.deploy(feeToken.target, ORDER_FEE, [
      sellTokenA.target,
      sellTokenB.target,
      buyToken.target,
      feeToken.target,
    ])
    await otcSwap.waitForDeployment()

    requireFunction(otcSwap, 'withdrawAllClaims()')
    requireFunction(otcSwap, 'withdrawAllClaims(uint256)')
    requireFunction(otcSwap, 'claimable(address,address)')

    // Create two canceled orders to generate two claimable tokens.
    await sellTokenA.transfer(maker.address, SELL_AMOUNT)
    await sellTokenB.transfer(maker.address, SELL_AMOUNT)
    await feeToken.transfer(maker.address, ORDER_FEE * 20n)

    await sellTokenA.connect(maker).approve(otcSwap.target, SELL_AMOUNT)
    await sellTokenB.connect(maker).approve(otcSwap.target, SELL_AMOUNT)
    await feeToken.connect(maker).approve(otcSwap.target, ORDER_FEE * 20n)

    await otcSwap
      .connect(maker)
      .createOrder(ethers.ZeroAddress, sellTokenA.target, SELL_AMOUNT, buyToken.target, BUY_AMOUNT)
    await otcSwap
      .connect(maker)
      .createOrder(ethers.ZeroAddress, sellTokenB.target, SELL_AMOUNT, buyToken.target, BUY_AMOUNT)

    await otcSwap.connect(maker).cancelOrder(0)
    await otcSwap.connect(maker).cancelOrder(1)

    // Force one token transfer failure during batch withdraw.
    await sellTokenB.connect(owner).pause()

    const beforeA = await otcSwap.claimable(maker.address, sellTokenA.target)
    const beforeB = await otcSwap.claimable(maker.address, sellTokenB.target)
    await expect(otcSwap.connect(maker)['withdrawAllClaims(uint256)'](10)).to.be.reverted

    // Atomic behavior: both claimables remain intact after failed batch.
    expect(await otcSwap.claimable(maker.address, sellTokenA.target)).to.equal(beforeA)
    expect(await otcSwap.claimable(maker.address, sellTokenB.target)).to.equal(beforeB)
  })
})
