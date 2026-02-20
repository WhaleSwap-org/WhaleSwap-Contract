// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @dev Transfer-tax token used to model fee-on-transfer accounting failures.
contract DeflationaryFeeToken is ERC20, Ownable {
    uint256 public constant TAX_BPS = 5000; // 50%
    address public taxCollector;

    constructor(string memory name, string memory symbol) ERC20(name, symbol) Ownable(msg.sender) {
        taxCollector = msg.sender;
        _mint(msg.sender, 1_000_000 * 10 ** decimals());
    }

    function setTaxCollector(address newCollector) external onlyOwner {
        require(newCollector != address(0), "Invalid collector");
        taxCollector = newCollector;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }

        uint256 tax = (value * TAX_BPS) / 10_000;
        uint256 remaining = value - tax;

        super._update(from, taxCollector, tax);
        super._update(from, to, remaining);
    }
}
