// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./inheritance/Controllable.sol";
import "./interface/ICLVault.sol";
import "./interface/IController.sol";
import "./interface/chainlink/AutomationCompatibleInterface.sol";

contract ChainlinkChecker is Controllable, AutomationCompatibleInterface {
    
    address[] public vaults;
    mapping(address => bool) public isVault;

    error NotNeeded();
    error DataMismatch();
    error BadSelector();
    error UnknownVault(address v);
    error CallFailed(bytes revertData);

    constructor(
        address _storage
    ) Controllable(_storage) {}

    function addVault(address v) public onlyGovernance {
        require(v != address(0), "zero");
        require(!isVault[v], "duplicate");
        isVault[v] = true;
        vaults.push(v);
    }

    function addVaults(address[] memory _targets) public onlyGovernance {
        for (uint256 i = 0; i < _targets.length; i++) {
            addVault(_targets[i]);
        }
    }

    function removeVault(address v) public onlyGovernance {
        if (!isVault[v]) revert UnknownVault(v);
        isVault[v] = false;

        uint256 i = getVaultIndex(v);
        uint256 last = vaults.length - 1;
        vaults[i] = vaults[last];
        vaults.pop();
    }

    function removeVaults(address[] memory _targets) public onlyGovernance {
        for (uint256 i = 0; i < _targets.length; i++) {
            removeVault(_targets[i]);
        }
    }

    /// @dev Reverts with UnknownVault if `v` is not registered.
    function getVaultIndex(address v) public view returns(uint256) {
        uint256 n = vaults.length;
        for (uint256 i = 0; i < n; i++) {
            if (vaults[i] == v) return i;
        }
        revert UnknownVault(v);
    }

    function _checker() internal view returns (bool canExec, bytes memory execPayload) {
        uint256 n = vaults.length;
        for (uint256 i = 0; i < n; i++) {
            (canExec, execPayload) = ICLVault(vaults[i]).checker();
            if (canExec) return(true, execPayload);
        }

        return(false, bytes("No vaults to harvest"));
    }

    function _selector(bytes memory data) internal pure returns (bytes4 sel) {
        if (data.length < 4) return 0x0;
        assembly { sel := mload(add(data, 32)) }
    }

    function checkUpkeep(bytes calldata) external override view returns (bool upkeepNeeded, bytes memory performData) {
        (upkeepNeeded, performData) = _checker();
    }

    function performUpkeep(bytes calldata performData) external override {
        (bool checkNeeded, bytes memory checkData) = _checker();
        if (!checkNeeded) revert NotNeeded();
        if (keccak256(performData) != keccak256(checkData)) revert DataMismatch();
        if (_selector(performData) != IController.doHardWork.selector) revert BadSelector();
        (bool success, bytes memory returnData ) = controller().call(performData);
        if (!success) revert CallFailed(returnData);
    }
}