// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract WhaleSwap is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant ORDER_EXPIRY = 7 days;
    uint256 public constant GRACE_PERIOD = 7 days;

    address public feeToken;
    uint256 public orderCreationFeeAmount;
    uint256 public firstOrderId;
    uint256 public nextOrderId;
    bool public isDisabled;

    mapping(address => bool) public allowedTokens;
    address[] public allowedTokensList;
    mapping(address => uint256) private allowedTokenIndex;

    // Per-token fee accounting.
    mapping(address => uint256) public accumulatedFeesByToken;

    // Claimable balances by user and token.
    mapping(address => mapping(address => uint256)) public claimable;
    mapping(address => address[]) private claimableTokensByUser;
    mapping(address => mapping(address => bool)) public hasClaimableToken;
    mapping(address => mapping(address => uint256)) public claimableTokenIndex;

    enum OrderStatus {
        Active,
        Filled,
        Canceled
    }

    struct Order {
        address maker;
        address taker; // address(0) if open to anyone
        address sellToken;
        uint256 sellAmount;
        address buyToken;
        uint256 buyAmount;
        uint256 timestamp;
        OrderStatus status;
        address feeToken; // Snapshot at create time
        uint256 orderCreationFee; // Snapshot at create time
    }

    mapping(uint256 => Order) public orders;

    event OrderCreated(
        uint256 indexed orderId,
        address indexed maker,
        address indexed taker,
        address sellToken,
        uint256 sellAmount,
        address buyToken,
        uint256 buyAmount,
        uint256 timestamp,
        address feeToken,
        uint256 orderCreationFee
    );

    event OrderFilled(
        uint256 indexed orderId,
        address indexed maker,
        address indexed taker,
        address sellToken,
        uint256 sellAmount,
        address buyToken,
        uint256 buyAmount,
        uint256 timestamp
    );

    event OrderCanceled(
        uint256 indexed orderId,
        address indexed maker,
        uint256 timestamp
    );

    event OrderCleanedUp(
        uint256 indexed orderId,
        address indexed maker,
        uint256 timestamp
    );

    event CleanupFeesDistributed(
        address indexed recipient,
        address indexed feeToken,
        uint256 amount,
        uint256 timestamp
    );

    event ContractDisabled(
        address indexed owner,
        uint256 timestamp
    );

    event FeeConfigUpdated(
        address indexed feeToken,
        uint256 feeAmount,
        uint256 timestamp
    );

    event AllowedTokensUpdated(
        address[] tokens,
        bool[] allowed,
        uint256 timestamp
    );

    event ClaimCredited(
        address indexed beneficiary,
        address indexed token,
        uint256 amount,
        uint256 indexed orderId,
        string reason,
        uint256 timestamp
    );

    event ClaimWithdrawn(
        address indexed beneficiary,
        address indexed token,
        uint256 amount,
        uint256 timestamp
    );

    modifier validOrder(uint256 orderId) {
        require(orders[orderId].maker != address(0), "Order does not exist");
        require(orders[orderId].status == OrderStatus.Active, "Order is not active");
        _;
    }

    constructor(address _feeToken, uint256 _feeAmount, address[] memory _allowedTokens) Ownable(msg.sender) {
        require(_feeToken != address(0), "Invalid fee token");
        require(_feeAmount > 0, "Invalid fee amount");
        require(_allowedTokens.length > 0, "Must specify allowed tokens");

        feeToken = _feeToken;
        orderCreationFeeAmount = _feeAmount;

        // Initialize allowlist with de-duplication.
        for (uint256 i = 0; i < _allowedTokens.length; i++) {
            address token = _allowedTokens[i];
            require(token != address(0), "Invalid token address");
            if (!allowedTokens[token]) {
                allowedTokens[token] = true;
                allowedTokenIndex[token] = allowedTokensList.length;
                allowedTokensList.push(token);
            }
        }

        emit FeeConfigUpdated(_feeToken, _feeAmount, block.timestamp);
    }

    function updateFeeConfig(address _feeToken, uint256 _feeAmount) external onlyOwner {
        require(_feeToken != address(0), "Invalid fee token");
        require(_feeAmount > 0, "Invalid fee amount");
        feeToken = _feeToken;
        orderCreationFeeAmount = _feeAmount;
        emit FeeConfigUpdated(_feeToken, _feeAmount, block.timestamp);
    }

    function disableContract() external onlyOwner {
        require(!isDisabled, "Contract already disabled");
        isDisabled = true;
        emit ContractDisabled(msg.sender, block.timestamp);
    }

    function updateAllowedTokens(address[] memory tokens, bool[] memory allowed) external onlyOwner {
        require(tokens.length == allowed.length, "Arrays length mismatch");
        require(tokens.length > 0, "Empty arrays");

        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            require(token != address(0), "Invalid token address");

            if (allowed[i] && !allowedTokens[token]) {
                allowedTokens[token] = true;
                allowedTokenIndex[token] = allowedTokensList.length;
                allowedTokensList.push(token);
            } else if (!allowed[i] && allowedTokens[token]) {
                _removeFromAllowedTokensList(token);
                allowedTokens[token] = false;
            }
        }

        emit AllowedTokensUpdated(tokens, allowed, block.timestamp);
    }

    function _removeFromAllowedTokensList(address tokenToRemove) internal {
        uint256 index = allowedTokenIndex[tokenToRemove];
        uint256 lastIndex = allowedTokensList.length - 1;

        if (index != lastIndex) {
            address movedToken = allowedTokensList[lastIndex];
            allowedTokensList[index] = movedToken;
            allowedTokenIndex[movedToken] = index;
        }

        allowedTokensList.pop();
        delete allowedTokenIndex[tokenToRemove];
    }

    function getAllowedTokens() external view returns (address[] memory) {
        return allowedTokensList;
    }

    function getAllowedTokensCount() external view returns (uint256) {
        return allowedTokensList.length;
    }

    function getClaimableTokens(address user) external view returns (address[] memory) {
        return claimableTokensByUser[user];
    }

    function createOrder(
        address taker,
        address sellToken,
        uint256 sellAmount,
        address buyToken,
        uint256 buyAmount
    ) external nonReentrant returns (uint256) {
        require(!isDisabled, "Contract is disabled");
        require(sellToken != address(0), "Invalid sell token");
        require(buyToken != address(0), "Invalid buy token");
        require(sellAmount > 0, "Invalid sell amount");
        require(buyAmount > 0, "Invalid buy amount");
        require(sellToken != buyToken, "Cannot swap same token");
        require(allowedTokens[sellToken], "Sell token not allowed");
        require(allowedTokens[buyToken], "Buy token not allowed");

        // Snapshot current fee config for this order.
        address orderFeeToken = feeToken;
        uint256 orderFeeAmount = orderCreationFeeAmount;

        uint256 orderId = nextOrderId;
        nextOrderId = orderId + 1;
        uint256 feeBalanceBefore = IERC20(orderFeeToken).balanceOf(address(this));
        IERC20(orderFeeToken).safeTransferFrom(msg.sender, address(this), orderFeeAmount);
        uint256 actualOrderFee = IERC20(orderFeeToken).balanceOf(address(this)) - feeBalanceBefore;
        require(actualOrderFee > 0, "Invalid received fee");

        uint256 sellBalanceBefore = IERC20(sellToken).balanceOf(address(this));
        IERC20(sellToken).safeTransferFrom(msg.sender, address(this), sellAmount);
        uint256 actualSellAmount = IERC20(sellToken).balanceOf(address(this)) - sellBalanceBefore;
        require(actualSellAmount > 0, "Invalid received sell amount");

        orders[orderId] = Order({
            maker: msg.sender,
            taker: taker,
            sellToken: sellToken,
            sellAmount: actualSellAmount,
            buyToken: buyToken,
            buyAmount: buyAmount,
            timestamp: block.timestamp,
            status: OrderStatus.Active,
            feeToken: orderFeeToken,
            orderCreationFee: actualOrderFee
        });
        accumulatedFeesByToken[orderFeeToken] += actualOrderFee;

        emit OrderCreated(
            orderId,
            msg.sender,
            taker,
            sellToken,
            actualSellAmount,
            buyToken,
            buyAmount,
            block.timestamp,
            orderFeeToken,
            actualOrderFee
        );

        return orderId;
    }

    function fillOrder(uint256 orderId) external nonReentrant validOrder(orderId) {
        Order storage order = orders[orderId];

        require(block.timestamp <= order.timestamp + ORDER_EXPIRY, "Order has expired");
        require(order.taker == address(0) || order.taker == msg.sender, "Not authorized to fill this order");

        order.status = OrderStatus.Filled;

        IERC20(order.buyToken).safeTransferFrom(msg.sender, order.maker, order.buyAmount);
        IERC20(order.sellToken).safeTransfer(msg.sender, order.sellAmount);

        emit OrderFilled(
            orderId,
            order.maker,
            msg.sender,
            order.sellToken,
            order.sellAmount,
            order.buyToken,
            order.buyAmount,
            block.timestamp
        );
    }

    function cancelOrder(uint256 orderId) external nonReentrant validOrder(orderId) {
        Order storage order = orders[orderId];
        require(order.maker == msg.sender, "Only maker can cancel order");

        order.status = OrderStatus.Canceled;
        _creditClaim(order.maker, order.sellToken, order.sellAmount, orderId, "cancel-principal");

        emit OrderCanceled(orderId, msg.sender, block.timestamp);
    }

    function cleanupExpiredOrders() external nonReentrant {
        require(firstOrderId < nextOrderId, "No orders to clean up");

        uint256 orderId = firstOrderId;
        Order storage order = orders[orderId];

        // Skip empty slots.
        if (order.maker == address(0)) {
            firstOrderId++;
            return;
        }

        // Not yet cleanup-eligible.
        if (block.timestamp <= order.timestamp + ORDER_EXPIRY + GRACE_PERIOD) {
            return;
        }

        // Active orders still have escrowed sell token owned by maker.
        if (order.status == OrderStatus.Active) {
            _creditClaim(order.maker, order.sellToken, order.sellAmount, orderId, "cleanup-active-principal");
        }

        uint256 cleanupFee = order.orderCreationFee;
        if (cleanupFee > 0) {
            require(accumulatedFeesByToken[order.feeToken] >= cleanupFee, "Insufficient fee balance");
            accumulatedFeesByToken[order.feeToken] -= cleanupFee;
            _creditClaim(msg.sender, order.feeToken, cleanupFee, orderId, "cleanup-fee");
            emit CleanupFeesDistributed(msg.sender, order.feeToken, cleanupFee, block.timestamp);
        }

        address maker = order.maker;
        delete orders[orderId];
        firstOrderId++;

        emit OrderCleanedUp(orderId, maker, block.timestamp);
    }

    function withdraw(address token, uint256 amount) external nonReentrant {
        require(token != address(0), "Invalid token");
        require(amount > 0, "Invalid amount");

        uint256 available = claimable[msg.sender][token];
        require(available >= amount, "Insufficient claimable balance");

        uint256 remaining = available - amount;
        claimable[msg.sender][token] = remaining;
        if (remaining == 0) {
            _removeClaimableToken(msg.sender, token);
        }

        IERC20(token).safeTransfer(msg.sender, amount);
        emit ClaimWithdrawn(msg.sender, token, amount, block.timestamp);
    }

    function withdrawAllClaims() external nonReentrant {
        _withdrawAllClaims(claimableTokensByUser[msg.sender].length);
    }

    function withdrawAllClaims(uint256 maxTokens) external nonReentrant {
        require(maxTokens > 0, "Invalid maxTokens");
        _withdrawAllClaims(maxTokens);
    }

    function _withdrawAllClaims(uint256 maxTokens) internal {
        uint256 processed = 0;
        while (processed < maxTokens && claimableTokensByUser[msg.sender].length > 0) {
            uint256 lastIndex = claimableTokensByUser[msg.sender].length - 1;
            address token = claimableTokensByUser[msg.sender][lastIndex];
            uint256 amount = claimable[msg.sender][token];

            // Defensive cleanup for invariant drift.
            if (amount == 0) {
                _removeClaimableToken(msg.sender, token);
                continue;
            }

            claimable[msg.sender][token] = 0;
            _removeClaimableToken(msg.sender, token);

            IERC20(token).safeTransfer(msg.sender, amount);
            emit ClaimWithdrawn(msg.sender, token, amount, block.timestamp);
            processed++;
        }
    }

    function _creditClaim(
        address beneficiary,
        address token,
        uint256 amount,
        uint256 orderId,
        string memory reason
    ) internal {
        if (amount == 0) {
            return;
        }
        require(beneficiary != address(0), "Invalid beneficiary");
        require(token != address(0), "Invalid token");

        if (!hasClaimableToken[beneficiary][token]) {
            hasClaimableToken[beneficiary][token] = true;
            claimableTokenIndex[beneficiary][token] = claimableTokensByUser[beneficiary].length;
            claimableTokensByUser[beneficiary].push(token);
        }

        claimable[beneficiary][token] += amount;
        emit ClaimCredited(beneficiary, token, amount, orderId, reason, block.timestamp);
    }

    function _removeClaimableToken(address user, address token) internal {
        if (!hasClaimableToken[user][token]) {
            return;
        }

        uint256 index = claimableTokenIndex[user][token];
        uint256 lastIndex = claimableTokensByUser[user].length - 1;

        if (index != lastIndex) {
            address movedToken = claimableTokensByUser[user][lastIndex];
            claimableTokensByUser[user][index] = movedToken;
            claimableTokenIndex[user][movedToken] = index;
        }

        claimableTokensByUser[user].pop();
        delete claimableTokenIndex[user][token];
        hasClaimableToken[user][token] = false;
    }
}
