const { expect } = require('chai')
const { ethers } = require('hardhat')

const DAY = 24 * 60 * 60

describe('OTCSwap - Guards and Edge Cases', function () {
  let otcSwap
  let tokenA
  let tokenB
  let tokenC
  let feeToken
  let owner
  let maker
  let taker
  let other
  let cleaner

  const ZERO_ADDRESS = ethers.ZeroAddress
  const ORDER_FEE = ethers.parseUnits('1', 18)
  const SELL_AMOUNT = ethers.parseEther('10')
  const BUY_AMOUNT = ethers.parseEther('20')

  async function advanceAfterOrderExpiry() {
    await ethers.provider.send('evm_increaseTime', [7 * DAY + 1])
    await ethers.provider.send('evm_mine', [])
  }

  async function advanceAfterCleanupWindow() {
    await ethers.provider.send('evm_increaseTime', [14 * DAY + 1])
    await ethers.provider.send('evm_mine', [])
  }

  async function approveMaker(sellToken, sellAmount, feeAmount = ORDER_FEE) {
    await sellToken.connect(maker).approve(otcSwap.target, sellAmount)
    await feeToken.connect(maker).approve(otcSwap.target, feeAmount)
  }

  async function createDefaultOrder() {
    await approveMaker(tokenA, SELL_AMOUNT)
    await otcSwap
      .connect(maker)
      .createOrder(ZERO_ADDRESS, tokenA.target, SELL_AMOUNT, tokenB.target, BUY_AMOUNT)
  }

  beforeEach(async function () {
    ;[owner, maker, taker, other, cleaner] = await ethers.getSigners()

    const TestToken = await ethers.getContractFactory('TestToken')
    tokenA = await TestToken.deploy('Token A', 'TKA')
    await tokenA.waitForDeployment()
    tokenB = await TestToken.deploy('Token B', 'TKB')
    await tokenB.waitForDeployment()
    tokenC = await TestToken.deploy('Token C', 'TKC')
    await tokenC.waitForDeployment()
    feeToken = await TestToken.deploy('Fee Token', 'FEE')
    await feeToken.waitForDeployment()

    const OTCSwap = await ethers.getContractFactory('OTCSwap')
    otcSwap = await OTCSwap.deploy(feeToken.target, ORDER_FEE, [
      tokenA.target,
      tokenB.target,
      feeToken.target,
    ])
    await otcSwap.waitForDeployment()

    const initial = ethers.parseEther('10000')
    await tokenA.transfer(maker.address, initial)
    await tokenB.transfer(maker.address, initial)
    await tokenB.transfer(taker.address, initial)
    await tokenC.transfer(maker.address, initial)
    await feeToken.transfer(maker.address, ORDER_FEE * 1000n)
  })

  describe('Admin Guards', function () {
    it('reverts updateFeeConfig for zero fee token', async function () {
      await expect(otcSwap.connect(owner).updateFeeConfig(ZERO_ADDRESS, ORDER_FEE)).to.be.revertedWith(
        'Invalid fee token'
      )
    })

    it('reverts updateFeeConfig for zero fee amount', async function () {
      await expect(otcSwap.connect(owner).updateFeeConfig(feeToken.target, 0)).to.be.revertedWith(
        'Invalid fee amount'
      )
    })

    it('reverts when disabling an already disabled contract', async function () {
      await otcSwap.connect(owner).disableContract()
      await expect(otcSwap.connect(owner).disableContract()).to.be.revertedWith(
        'Contract already disabled'
      )
    })
  })

  describe('Allowlist Guards', function () {
    it('reverts updateAllowedTokens for array length mismatch', async function () {
      await expect(
        otcSwap.connect(owner).updateAllowedTokens([tokenC.target], [true, false])
      ).to.be.revertedWith('Arrays length mismatch')
    })

    it('reverts updateAllowedTokens for empty arrays', async function () {
      await expect(otcSwap.connect(owner).updateAllowedTokens([], [])).to.be.revertedWith(
        'Empty arrays'
      )
    })

    it('reverts updateAllowedTokens for zero token address', async function () {
      await expect(
        otcSwap.connect(owner).updateAllowedTokens([ZERO_ADDRESS], [true])
      ).to.be.revertedWith('Invalid token address')
    })
  })

  describe('createOrder Guards', function () {
    it('reverts createOrder while contract is disabled', async function () {
      await otcSwap.connect(owner).disableContract()
      await approveMaker(tokenA, SELL_AMOUNT)
      await expect(
        otcSwap
          .connect(maker)
          .createOrder(ZERO_ADDRESS, tokenA.target, SELL_AMOUNT, tokenB.target, BUY_AMOUNT)
      ).to.be.revertedWith('Contract is disabled')
    })

    it('reverts createOrder for zero sell token', async function () {
      await expect(
        otcSwap
          .connect(maker)
          .createOrder(ZERO_ADDRESS, ZERO_ADDRESS, SELL_AMOUNT, tokenB.target, BUY_AMOUNT)
      ).to.be.revertedWith('Invalid sell token')
    })

    it('reverts createOrder for zero buy token', async function () {
      await expect(
        otcSwap
          .connect(maker)
          .createOrder(ZERO_ADDRESS, tokenA.target, SELL_AMOUNT, ZERO_ADDRESS, BUY_AMOUNT)
      ).to.be.revertedWith('Invalid buy token')
    })

    it('reverts createOrder for zero sell amount', async function () {
      await expect(
        otcSwap.connect(maker).createOrder(ZERO_ADDRESS, tokenA.target, 0, tokenB.target, BUY_AMOUNT)
      ).to.be.revertedWith('Invalid sell amount')
    })

    it('reverts createOrder for zero buy amount', async function () {
      await expect(
        otcSwap
          .connect(maker)
          .createOrder(ZERO_ADDRESS, tokenA.target, SELL_AMOUNT, tokenB.target, 0)
      ).to.be.revertedWith('Invalid buy amount')
    })

    it('reverts createOrder when swapping the same token', async function () {
      await expect(
        otcSwap
          .connect(maker)
          .createOrder(ZERO_ADDRESS, tokenA.target, SELL_AMOUNT, tokenA.target, BUY_AMOUNT)
      ).to.be.revertedWith('Cannot swap same token')
    })

    it('reverts createOrder when sell token is not allowed', async function () {
      await approveMaker(tokenC, SELL_AMOUNT)
      await expect(
        otcSwap
          .connect(maker)
          .createOrder(ZERO_ADDRESS, tokenC.target, SELL_AMOUNT, tokenB.target, BUY_AMOUNT)
      ).to.be.revertedWith('Sell token not allowed')
    })

    it('reverts createOrder when buy token is not allowed', async function () {
      await approveMaker(tokenA, SELL_AMOUNT)
      await expect(
        otcSwap
          .connect(maker)
          .createOrder(ZERO_ADDRESS, tokenA.target, SELL_AMOUNT, tokenC.target, BUY_AMOUNT)
      ).to.be.revertedWith('Buy token not allowed')
    })

    it('reverts createOrder for insufficient sell token allowance', async function () {
      await feeToken.connect(maker).approve(otcSwap.target, ORDER_FEE)
      await expect(
        otcSwap
          .connect(maker)
          .createOrder(ZERO_ADDRESS, tokenA.target, SELL_AMOUNT, tokenB.target, BUY_AMOUNT)
      ).to.be.revertedWith('Insufficient allowance for sell token')
    })

    it('reverts createOrder for insufficient fee token allowance', async function () {
      await tokenA.connect(maker).approve(otcSwap.target, SELL_AMOUNT)
      await expect(
        otcSwap
          .connect(maker)
          .createOrder(ZERO_ADDRESS, tokenA.target, SELL_AMOUNT, tokenB.target, BUY_AMOUNT)
      ).to.be.revertedWith('Insufficient allowance for fee')
    })
  })

  describe('fillOrder Guards', function () {
    it('reverts fillOrder for non-existent orders', async function () {
      await expect(otcSwap.connect(taker).fillOrder(999)).to.be.revertedWith('Order does not exist')
    })

    it('reverts fillOrder for canceled orders', async function () {
      await createDefaultOrder()
      await otcSwap.connect(maker).cancelOrder(0)
      await expect(otcSwap.connect(taker).fillOrder(0)).to.be.revertedWith('Order is not active')
    })

    it('reverts fillOrder for already filled orders', async function () {
      await createDefaultOrder()
      await tokenB.connect(taker).approve(otcSwap.target, BUY_AMOUNT)
      await otcSwap.connect(taker).fillOrder(0)
      await expect(otcSwap.connect(taker).fillOrder(0)).to.be.revertedWith('Order is not active')
    })

    it('reverts fillOrder for expired orders', async function () {
      await createDefaultOrder()
      await advanceAfterOrderExpiry()
      await tokenB.connect(taker).approve(otcSwap.target, BUY_AMOUNT)
      await expect(otcSwap.connect(taker).fillOrder(0)).to.be.revertedWith('Order has expired')
    })

    it('reverts fillOrder for insufficient buy token allowance', async function () {
      await createDefaultOrder()
      await expect(otcSwap.connect(taker).fillOrder(0)).to.be.revertedWith(
        'Insufficient allowance for buy token'
      )
    })
  })

  describe('cancelOrder Guards', function () {
    it('reverts cancelOrder when caller is not the maker', async function () {
      await createDefaultOrder()
      await expect(otcSwap.connect(other).cancelOrder(0)).to.be.revertedWith(
        'Only maker can cancel order'
      )
    })

    it('reverts cancelOrder for non-existent orders', async function () {
      await expect(otcSwap.connect(maker).cancelOrder(999)).to.be.revertedWith('Order does not exist')
    })

    it('reverts cancelOrder for already filled orders', async function () {
      await createDefaultOrder()
      await tokenB.connect(taker).approve(otcSwap.target, BUY_AMOUNT)
      await otcSwap.connect(taker).fillOrder(0)
      await expect(otcSwap.connect(maker).cancelOrder(0)).to.be.revertedWith('Order is not active')
    })
  })

  describe('cleanupExpiredOrders Guards', function () {
    it('reverts cleanupExpiredOrders when there are no orders', async function () {
      await expect(otcSwap.connect(cleaner).cleanupExpiredOrders()).to.be.revertedWith(
        'No orders to clean up'
      )
    })

    it('returns early and leaves state unchanged before cleanup eligibility', async function () {
      await createDefaultOrder()
      expect(await otcSwap.firstOrderId()).to.equal(0n)

      await expect(otcSwap.connect(cleaner).cleanupExpiredOrders()).to.not.be.reverted
      expect(await otcSwap.firstOrderId()).to.equal(0n)
      expect((await otcSwap.orders(0)).maker).to.equal(maker.address)
    })

    it('cleans canceled orders without double-crediting maker principal', async function () {
      await createDefaultOrder()
      await otcSwap.connect(maker).cancelOrder(0)
      expect(await otcSwap.claimable(maker.address, tokenA.target)).to.equal(SELL_AMOUNT)

      await advanceAfterCleanupWindow()
      await expect(otcSwap.connect(cleaner).cleanupExpiredOrders()).to.not.be.reverted

      expect((await otcSwap.orders(0)).maker).to.equal(ZERO_ADDRESS)
      expect(await otcSwap.firstOrderId()).to.equal(1n)
      expect(await otcSwap.claimable(maker.address, tokenA.target)).to.equal(SELL_AMOUNT)
      expect(await otcSwap.claimable(cleaner.address, feeToken.target)).to.equal(ORDER_FEE)
    })

    it('cleans filled orders and only credits cleanup fee to cleaner', async function () {
      await createDefaultOrder()
      await tokenB.connect(taker).approve(otcSwap.target, BUY_AMOUNT)
      await otcSwap.connect(taker).fillOrder(0)

      await advanceAfterCleanupWindow()
      await expect(otcSwap.connect(cleaner).cleanupExpiredOrders()).to.not.be.reverted

      expect((await otcSwap.orders(0)).maker).to.equal(ZERO_ADDRESS)
      expect(await otcSwap.claimable(maker.address, tokenA.target)).to.equal(0n)
      expect(await otcSwap.claimable(cleaner.address, feeToken.target)).to.equal(ORDER_FEE)
    })
  })

  describe('withdraw Guards', function () {
    it('reverts withdraw for zero token address', async function () {
      await expect(otcSwap.connect(maker).withdraw(ZERO_ADDRESS, 1)).to.be.revertedWith(
        'Invalid token'
      )
    })

    it('reverts withdraw for zero amount', async function () {
      await expect(otcSwap.connect(maker).withdraw(tokenA.target, 0)).to.be.revertedWith(
        'Invalid amount'
      )
    })

    it('reverts withdraw when claimable balance is insufficient', async function () {
      await expect(otcSwap.connect(maker).withdraw(tokenA.target, 1)).to.be.revertedWith(
        'Insufficient claimable balance'
      )
    })

    it('supports partial withdraw and keeps token discoverable until zero', async function () {
      await createDefaultOrder()
      await otcSwap.connect(maker).cancelOrder(0)

      const partial = SELL_AMOUNT / 2n
      await otcSwap.connect(maker).withdraw(tokenA.target, partial)

      expect(await otcSwap.claimable(maker.address, tokenA.target)).to.equal(SELL_AMOUNT - partial)
      expect(await otcSwap.hasClaimableToken(maker.address, tokenA.target)).to.equal(true)
      const list = await otcSwap.getClaimableTokens(maker.address)
      expect(list.map((a) => a.toLowerCase())).to.include(tokenA.target.toLowerCase())
    })
  })

  describe('withdrawAllClaims Guards', function () {
    it('reverts withdrawAllClaims(uint256) when maxTokens is zero', async function () {
      await expect(otcSwap.connect(maker)['withdrawAllClaims(uint256)'](0)).to.be.revertedWith(
        'Invalid maxTokens'
      )
    })

    it('withdraws all claimable tokens with the no-arg overload', async function () {
      await approveMaker(tokenA, SELL_AMOUNT, ORDER_FEE * 2n)
      await otcSwap
        .connect(maker)
        .createOrder(ZERO_ADDRESS, tokenA.target, SELL_AMOUNT, tokenB.target, BUY_AMOUNT)
      await approveMaker(tokenB, SELL_AMOUNT, ORDER_FEE * 2n)
      await otcSwap
        .connect(maker)
        .createOrder(ZERO_ADDRESS, tokenB.target, SELL_AMOUNT, tokenA.target, BUY_AMOUNT)

      await otcSwap.connect(maker).cancelOrder(0)
      await otcSwap.connect(maker).cancelOrder(1)
      expect((await otcSwap.getClaimableTokens(maker.address)).length).to.equal(2)

      await expect(otcSwap.connect(maker).withdrawAllClaims()).to.not.be.reverted

      expect(await otcSwap.claimable(maker.address, tokenA.target)).to.equal(0n)
      expect(await otcSwap.claimable(maker.address, tokenB.target)).to.equal(0n)
      expect((await otcSwap.getClaimableTokens(maker.address)).length).to.equal(0)
    })

    it('respects maxTokens cap in withdrawAllClaims(uint256)', async function () {
      const sellAmountB = ethers.parseEther('20')

      await approveMaker(tokenA, SELL_AMOUNT, ORDER_FEE * 2n)
      await otcSwap
        .connect(maker)
        .createOrder(ZERO_ADDRESS, tokenA.target, SELL_AMOUNT, tokenB.target, BUY_AMOUNT)
      await approveMaker(tokenB, sellAmountB, ORDER_FEE * 2n)
      await otcSwap
        .connect(maker)
        .createOrder(ZERO_ADDRESS, tokenB.target, sellAmountB, tokenA.target, BUY_AMOUNT)

      await otcSwap.connect(maker).cancelOrder(0)
      await otcSwap.connect(maker).cancelOrder(1)

      await expect(otcSwap.connect(maker)['withdrawAllClaims(uint256)'](1)).to.not.be.reverted

      // Withdraw loop processes the end of the user token list first.
      expect(await otcSwap.claimable(maker.address, tokenB.target)).to.equal(0n)
      expect(await otcSwap.claimable(maker.address, tokenA.target)).to.equal(SELL_AMOUNT)
      expect((await otcSwap.getClaimableTokens(maker.address)).length).to.equal(1)
    })
  })
})
