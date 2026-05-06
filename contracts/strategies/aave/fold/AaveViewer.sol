// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "../../../base/interface/aave/IPoolAddressesProvider.sol";
import "../../../base/interface/aave/IAaveOracle.sol";
import "../../../base/interface/aave/IPool.sol";

contract AaveViewer {
    using SafeMath for uint256;

    address public constant addressProvider = address(0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D);

    function getPrice(address assetToken, address quoteToken) public view returns (uint256) {
        address oracle = IPoolAddressesProvider(addressProvider).getPriceOracle();
        uint256 assetPrice = IAaveOracle(oracle).getAssetPrice(assetToken);
        uint256 quotePrice = IAaveOracle(oracle).getAssetPrice(quoteToken);
        return assetPrice.mul(1e18).div(quotePrice);
    }

    function getPositionHealth() public view returns (uint256) {
        address pool = IPoolAddressesProvider(addressProvider).getPool();
        (,,,,,uint256 healthFactor) = IPool(pool).getUserAccountData(msg.sender);
        return healthFactor;
    }
}