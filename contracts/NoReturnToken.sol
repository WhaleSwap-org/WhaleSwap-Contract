// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev ERC20-like token with transfer/transferFrom that do not return a boolean.
/// Mimics legacy tokens that violate the modern IERC20 return-value convention.
contract NoReturnToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol) {
        name = _name;
        symbol = _symbol;
        _mint(msg.sender, 1_000_000 * 10 ** decimals);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external {
        _transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "NoReturnToken: insufficient allowance");
        unchecked {
            allowance[from][msg.sender] = allowed - amount;
        }
        emit Approval(from, msg.sender, allowance[from][msg.sender]);
        _transfer(from, to, amount);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "NoReturnToken: transfer to zero");
        uint256 fromBal = balanceOf[from];
        require(fromBal >= amount, "NoReturnToken: insufficient balance");
        unchecked {
            balanceOf[from] = fromBal - amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
