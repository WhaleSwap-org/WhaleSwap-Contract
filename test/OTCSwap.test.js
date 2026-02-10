const { expect } = require('chai')
const { ethers } = require('hardhat')
const { anyValue } = require('@nomicfoundation/hardhat-chai-matchers/withArgs')

describe('OTCSwap', function () {
  let otcSwap
  let openSwap
  let tokenA
  let tokenB
  let tokenC
  let feeToken
  let owner
  let maker
  let taker
  let other

  const ZERO_ADDRESS = ethers.ZeroAddress
  const ORDER_FEE = ethers.parseUnits('1', 18)

  beforeEach(async function () {
    ;[owner, maker, taker, other] = await ethers.getSigners()

    const TestToken = await ethers.getContractFactory('TestToken')
    tokenA = await TestToken.deploy('Token A', 'TKA')
    await tokenA.waitForDeployment()
    tokenB = await TestToken.deploy('Token B', 'TKB')
    await tokenB.waitForDeployment()
    tokenC = await TestToken.deploy('Token C', 'TKC')
    await tokenC.waitForDeployment()
    feeToken = await TestToken.deploy('DAI Stablecoin', 'DAI')
    await feeToken.waitForDeployment()

    const OTCSwap = await ethers.getContractFactory('OTCSwap')
    otcSwap = await OTCSwap.deploy(feeToken.target, ORDER_FEE, [
      tokenA.target,
      tokenB.target,
      feeToken.target,
    ])
    await otcSwap.waitForDeployment()

    // Same contract but with an empty allowlist: should accept any ERC20s.
    openSwap = await OTCSwap.deploy(feeToken.target, ORDER_FEE, [])
    await openSwap.waitForDeployment()

    // Fund maker + taker
    const initial = ethers.parseEther('10000')
    await tokenA.transfer(maker.address, initial)
    await tokenB.transfer(taker.address, initial)
    await tokenC.transfer(maker.address, initial)

    // Fee token
    await feeToken.transfer(maker.address, ORDER_FEE * 1000n)
  })

  describe('Contract Administration', function () {
    it('owner can update fee config', async function () {
      const newAmount = ORDER_FEE * 2n
      await expect(otcSwap.connect(owner).updateFeeConfig(feeToken.target, newAmount))
        .to.emit(otcSwap, 'FeeConfigUpdated')
        .withArgs(feeToken.target, newAmount, anyValue)

      expect(await otcSwap.feeToken()).to.equal(feeToken.target)
      expect(await otcSwap.orderCreationFeeAmount()).to.equal(newAmount)
    })

    it('non-owner cannot update fee config', async function () {
      await expect(
        otcSwap.connect(maker).updateFeeConfig(feeToken.target, ORDER_FEE)
      ).to.be.revertedWithCustomError(otcSwap, 'OwnableUnauthorizedAccount')
    })

    it('owner can disable contract', async function () {
      await expect(otcSwap.connect(owner).disableContract())
        .to.emit(otcSwap, 'ContractDisabled')
        .withArgs(owner.address, anyValue)

      expect(await otcSwap.isDisabled()).to.equal(true)
    })
  })

  async function approveMakerForOrder(contract, sellToken, sellAmount) {
    await sellToken.connect(maker).approve(contract.target, sellAmount)
    await feeToken.connect(maker).approve(contract.target, ORDER_FEE * 1000n)
  }

  describe('Order Creation', function () {
    it('creates an order and charges the fee', async function () {
      const sellAmount = ethers.parseEther('100')
      const buyAmount = ethers.parseEther('200')

      await approveMakerForOrder(otcSwap, tokenA, sellAmount)

      await expect(
        otcSwap.connect(maker).createOrder(
          ZERO_ADDRESS,
          tokenA.target,
          sellAmount,
          tokenB.target,
          buyAmount
        )
      )
        .to.emit(otcSwap, 'OrderCreated')
        .withArgs(
          0,
          maker.address,
          ZERO_ADDRESS,
          tokenA.target,
          sellAmount,
          tokenB.target,
          buyAmount,
          anyValue,
          feeToken.target,
          ORDER_FEE
        )

      expect(await feeToken.balanceOf(otcSwap.target)).to.equal(ORDER_FEE)
      expect(await tokenA.balanceOf(otcSwap.target)).to.equal(sellAmount)
    })

    it('enforces allowlist when configured', async function () {
      const sellAmount = ethers.parseEther('10')
      const buyAmount = ethers.parseEther('20')

      await approveMakerForOrder(otcSwap, tokenC, sellAmount)
      await expect(
        otcSwap.connect(maker).createOrder(
          ZERO_ADDRESS,
          tokenC.target,
          sellAmount,
          tokenB.target,
          buyAmount
        )
      ).to.be.revertedWith('Sell token not allowed')
    })

    it('does not enforce allowlist when deployed with empty allowlist', async function () {
      const sellAmount = ethers.parseEther('10')
      const buyAmount = ethers.parseEther('20')

      await approveMakerForOrder(openSwap, tokenC, sellAmount)
      await expect(
        openSwap.connect(maker).createOrder(
          ZERO_ADDRESS,
          tokenC.target,
          sellAmount,
          tokenB.target,
          buyAmount
        )
      ).to.emit(openSwap, 'OrderCreated')
    })
  })

  describe('Order Fill / Cancel', function () {
    it('fills an order (maker sells A for B)', async function () {
      const sellAmount = ethers.parseEther('100')
      const buyAmount = ethers.parseEther('200')

      await approveMakerForOrder(otcSwap, tokenA, sellAmount)
      await otcSwap.connect(maker).createOrder(
        ZERO_ADDRESS,
        tokenA.target,
        sellAmount,
        tokenB.target,
        buyAmount
      )

      await tokenB.connect(taker).approve(otcSwap.target, buyAmount)

      const makerB0 = await tokenB.balanceOf(maker.address)
      const takerA0 = await tokenA.balanceOf(taker.address)

      await expect(otcSwap.connect(taker).fillOrder(0)).to.emit(otcSwap, 'OrderFilled')

      expect(await tokenB.balanceOf(maker.address)).to.equal(makerB0 + buyAmount)
      expect(await tokenA.balanceOf(taker.address)).to.equal(takerA0 + sellAmount)
    })

    it('enforces taker if specified', async function () {
      const sellAmount = ethers.parseEther('10')
      const buyAmount = ethers.parseEther('20')

      await approveMakerForOrder(otcSwap, tokenA, sellAmount)
      await otcSwap.connect(maker).createOrder(
        other.address,
        tokenA.target,
        sellAmount,
        tokenB.target,
        buyAmount
      )

      await tokenB.connect(taker).approve(otcSwap.target, buyAmount)
      await expect(otcSwap.connect(taker).fillOrder(0)).to.be.revertedWith(
        'Not authorized to fill this order'
      )
    })

    it('maker can cancel an active order and receive sell tokens back', async function () {
      const sellAmount = ethers.parseEther('10')
      const buyAmount = ethers.parseEther('20')

      await approveMakerForOrder(otcSwap, tokenA, sellAmount)
      await otcSwap.connect(maker).createOrder(
        ZERO_ADDRESS,
        tokenA.target,
        sellAmount,
        tokenB.target,
        buyAmount
      )

      const makerA0 = await tokenA.balanceOf(maker.address)
      await expect(otcSwap.connect(maker).cancelOrder(0)).to.emit(otcSwap, 'OrderCanceled')
      expect(await tokenA.balanceOf(maker.address)).to.equal(makerA0 + sellAmount)
    })
  })
})
