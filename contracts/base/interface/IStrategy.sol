// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

interface IStrategy {
    function isUnsalvageableToken(address token) external view returns (bool);

    function salvageToken(address recipient, address token, uint amount) external;

    function governance() external view returns (address);

    function controller() external view returns (address);

    function underlying() external view returns (address);

    function vault() external view returns (address);

    function withdrawAllToVault() external;
    function withdrawAllToVault(bool compound) external;

    function withdrawToVault(uint256 _amount) external;

    function investedUnderlyingBalance() external view returns (uint256);

    function doHardWork() external;

    function strategist() external view returns (address);

    function morphoClaim(address _distr, bytes calldata _txData) external;

    function preInteract() external;
}
