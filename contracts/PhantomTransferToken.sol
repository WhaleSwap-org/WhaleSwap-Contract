// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @dev Malicious token that can report successful transfers without moving balances.
contract PhantomTransferToken is ERC20, Ownable {
    bool public phantomTransfersEnabled;

    constructor(string memory name, string memory symbol) ERC20(name, symbol) Ownable(msg.sender) {
        _mint(msg.sender, 1_000_000 * 10 ** decimals());
    }

    function setPhantomTransfersEnabled(bool enabled) external onlyOwner {
        phantomTransfersEnabled = enabled;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) public virtual override returns (bool) {
        if (phantomTransfersEnabled) {
            emit Transfer(_msgSender(), to, amount);
            return true;
        }
        return super.transfer(to, amount);
    }
}
