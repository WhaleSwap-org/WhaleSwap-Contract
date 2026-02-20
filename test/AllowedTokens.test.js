const { expect } = require('chai')
const { ethers } = require('hardhat')

describe('OTCSwap - Allowed Tokens', function () {
  let otcSwap
  let tokenA
  let tokenB
  let tokenC
  let feeToken
  let owner
  let alice

  const ORDER_FEE = ethers.parseUnits('1', 18)

  beforeEach(async function () {
    ;[owner, alice] = await ethers.getSigners()

    const TestToken = await ethers.getContractFactory('TestToken')
    tokenA = await TestToken.deploy('Token A', 'TKA')
    await tokenA.waitForDeployment()
    tokenB = await TestToken.deploy('Token B', 'TKB')
    await tokenB.waitForDeployment()
    tokenC = await TestToken.deploy('Token C', 'TKC')
    await tokenC.waitForDeployment()
    feeToken = await TestToken.deploy('DAI Stablecoin', 'DAI')
    await feeToken.waitForDeployment()

    const OTCSwap = await ethers.getContractFactory('WhaleSwap')
    otcSwap = await OTCSwap.deploy(feeToken.target, ORDER_FEE, [
      tokenA.target,
      tokenB.target,
      feeToken.target,
    ])
    await otcSwap.waitForDeployment()
  })

  describe('Constructor', function () {
    it('initializes allowed tokens correctly', async function () {
      expect(await otcSwap.allowedTokens(tokenA.target)).to.equal(true)
      expect(await otcSwap.allowedTokens(tokenB.target)).to.equal(true)
      expect(await otcSwap.allowedTokens(feeToken.target)).to.equal(true)
      expect(await otcSwap.allowedTokens(tokenC.target)).to.equal(false)

      expect(await otcSwap.getAllowedTokensCount()).to.equal(3n)
      const tokens = await otcSwap.getAllowedTokens()
      expect(tokens).to.have.length(3)
      expect(tokens).to.include(tokenA.target)
      expect(tokens).to.include(tokenB.target)
      expect(tokens).to.include(feeToken.target)
    })

    it('reverts if no allowed tokens provided', async function () {
      const OTCSwap = await ethers.getContractFactory('WhaleSwap')
      await expect(OTCSwap.deploy(feeToken.target, ORDER_FEE, [])).to.be.revertedWith(
        'Must specify allowed tokens'
      )
    })

    it('reverts if invalid token address is provided in allowlist', async function () {
      const OTCSwap = await ethers.getContractFactory('WhaleSwap')
      await expect(
        OTCSwap.deploy(feeToken.target, ORDER_FEE, [ethers.ZeroAddress])
      ).to.be.revertedWith('Invalid token address')
    })
  })

  describe('updateAllowedTokens', function () {
    it('allows owner to add a token', async function () {
      await otcSwap.connect(owner).updateAllowedTokens([tokenC.target], [true])
      expect(await otcSwap.allowedTokens(tokenC.target)).to.equal(true)
      expect(await otcSwap.getAllowedTokens()).to.include(tokenC.target)
    })

    it('allows owner to remove a token', async function () {
      await otcSwap.connect(owner).updateAllowedTokens([tokenA.target], [false])
      expect(await otcSwap.allowedTokens(tokenA.target)).to.equal(false)
      expect(await otcSwap.getAllowedTokens()).to.not.include(tokenA.target)
    })

    it('reverts for non-owner', async function () {
      await expect(
        otcSwap.connect(alice).updateAllowedTokens([tokenC.target], [true])
      ).to.be.revertedWithCustomError(otcSwap, 'OwnableUnauthorizedAccount')
    })

    it('maintains list integrity across swap-and-pop removals', async function () {
      const TestToken = await ethers.getContractFactory('TestToken')
      const tokenD = await TestToken.deploy('Token D', 'TKD')
      await tokenD.waitForDeployment()

      await otcSwap.connect(owner).updateAllowedTokens([tokenC.target, tokenD.target], [true, true])
      expect(await otcSwap.getAllowedTokensCount()).to.equal(5n)

      await otcSwap.connect(owner).updateAllowedTokens([tokenB.target], [false])
      let tokens = await otcSwap.getAllowedTokens()
      expect(tokens).to.have.length(4)
      expect(tokens).to.not.include(tokenB.target)
      expect(tokens).to.include(tokenA.target)
      expect(tokens).to.include(tokenC.target)
      expect(tokens).to.include(tokenD.target)
      expect(tokens).to.include(feeToken.target)

      await otcSwap.connect(owner).updateAllowedTokens([tokenA.target], [false])
      tokens = await otcSwap.getAllowedTokens()
      expect(tokens).to.have.length(3)
      expect(tokens).to.not.include(tokenA.target)
      expect(tokens).to.include(tokenC.target)
      expect(tokens).to.include(tokenD.target)
      expect(tokens).to.include(feeToken.target)

      await otcSwap.connect(owner).updateAllowedTokens([tokenB.target], [true])
      tokens = await otcSwap.getAllowedTokens()
      expect(tokens).to.have.length(4)
      expect(tokens).to.include(tokenB.target)
    })
  })
})
