// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./inheritance/Controllable.sol";
import "./interface/ICLVault.sol";
import "./interface/chainlink/AutomationCompatibleInterface.sol";

/// @title CLChainlinkChecker
/// @notice Chainlink Automation–compatible upkeep contract for `CLVault.rebalanceCurrentTick`.
///         For each registered CL vault, periodically calls `vault.checker()`; if any returns
///         `canExec = true`, surfaces the encoded rebalance call so the Chainlink Automation
///         forwarder can execute it on-chain.
///
///         IMPORTANT — msg.sender chain at the vault:
///           Chainlink Forwarder → performUpkeep(this) → vault.call(payload)
///         The vault's `msg.sender` is THIS checker contract (not the forwarder), so the
///         vault's `rebalanceExecutor` must be set to THIS checker's address.
///
///         Operationally:
///           1. Deploy this contract.
///           2. `addVault(...)` for each CL vault to be monitored.
///           3. Register a Chainlink Automation Custom Logic upkeep targeting this contract.
///           4. From the vault's governance, call
///              `vault.setRebalanceConfig(deviation, cooldown, <this contract address>)`.
///           5. (Optional) Toggle `setFallthroughOnRace(true)` if multiple keepers may race
///              and you want this checker to pivot to the next eligible vault rather than
///              reverting when the supplied one is no longer eligible.
///
///         This is distinct from `ChainlinkChecker.sol` (which routes `doHardWork(vault)` calls
///         through the Controller for harvest upkeep) — CL rebalance is dispatched directly to
///         the vault and pre-encoded with `targetWidth` by the vault's own `checker()` view.
contract CLChainlinkChecker is Controllable, AutomationCompatibleInterface {
    address[] public vaults;
    mapping(address => bool) public isVault;

    /// @notice Whether `performUpkeep` should fall through to the next eligible vault if the
    /// supplied one is no longer eligible (e.g. another keeper rebalanced it in the same block).
    /// When true, performUpkeep tries the next vault rather than reverting.
    bool public fallthroughOnRace;

    event VaultAdded(address indexed vault);
    event VaultRemoved(address indexed vault);
    event RebalanceTriggered(address indexed vault, bytes payload);
    event FallthroughToggled(bool enabled);

    error UnknownVault(address vault);
    error Duplicate(address vault);
    error ZeroAddress();
    error NotNeeded();
    error DataMismatch();
    error BadSelector();
    error CallFailed(bytes revertData);
    error NoEligibleVault();

    constructor(address _storage) Controllable(_storage) {}

    // ------------------------------------------------------------------------------- registry --

    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }

    function getVaultIndex(address v) public view returns (uint256) {
        uint256 n = vaults.length;
        for (uint256 i = 0; i < n; i++) {
            if (vaults[i] == v) return i;
        }
        revert UnknownVault(v);
    }

    function addVault(address v) public onlyGovernance {
        if (v == address(0)) revert ZeroAddress();
        if (isVault[v]) revert Duplicate(v);
        isVault[v] = true;
        vaults.push(v);
        emit VaultAdded(v);
    }

    function addVaults(address[] calldata _targets) external onlyGovernance {
        for (uint256 i = 0; i < _targets.length; i++) addVault(_targets[i]);
    }

    function removeVault(address v) public onlyGovernance {
        if (!isVault[v]) revert UnknownVault(v);
        isVault[v] = false;
        uint256 i = getVaultIndex(v);
        uint256 last = vaults.length - 1;
        if (i != last) vaults[i] = vaults[last];
        vaults.pop();
        emit VaultRemoved(v);
    }

    function removeVaults(address[] calldata _targets) external onlyGovernance {
        for (uint256 i = 0; i < _targets.length; i++) removeVault(_targets[i]);
    }

    function setFallthroughOnRace(bool enabled) external onlyGovernance {
        fallthroughOnRace = enabled;
        emit FallthroughToggled(enabled);
    }

    // ----------------------------------------------------------------- Chainlink Automation --

    /// @notice Scan registered vaults for one whose `checker()` reports `canExec = true`. Returns
    /// the encoded `(vault, payload)` pair so `performUpkeep` can act on it without a re-scan.
    /// @dev `checkData` can be an `abi.encode(uint256 startIndex)` to shard a large registry
    /// across multiple upkeeps; absent that, scans from index 0.
    function checkUpkeep(bytes calldata checkData)
        external
        view
        override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        uint256 start = 0;
        if (checkData.length == 32) {
            start = abi.decode(checkData, (uint256));
        }
        uint256 n = vaults.length;
        for (uint256 i = 0; i < n; i++) {
            uint256 idx = (start + i) % n;
            address v = vaults[idx];
            (bool canExec, bytes memory payload) = ICLVault(v).checker();
            if (canExec) {
                return (true, abi.encode(v, payload));
            }
        }
        return (false, bytes(""));
    }

    /// @notice Forwarder entry point. Decodes `(vault, payload)` from `performData`, sanity
    /// checks that the call is in fact a `rebalanceCurrentTick` and that the vault is still
    /// registered, re-confirms eligibility, then executes.
    function performUpkeep(bytes calldata performData) external override {
        (address v, bytes memory payload) = abi.decode(performData, (address, bytes));
        if (!isVault[v]) revert UnknownVault(v);
        if (_selector(payload) != ICLVault(v).rebalanceCurrentTick.selector) revert BadSelector();

        // Re-confirm against the vault's view; protects against being driven by stale or
        // adversarial performData. If the supplied vault is no longer eligible but another one
        // in the registry is, `fallthroughOnRace` lets us pivot rather than reverting.
        (bool canExec, bytes memory live) = ICLVault(v).checker();
        if (canExec) {
            if (keccak256(live) != keccak256(payload)) revert DataMismatch();
            _execute(v, payload);
            return;
        }

        if (!fallthroughOnRace) revert NotNeeded();

        // Fallthrough: scan the rest of the registry for another eligible vault.
        uint256 n = vaults.length;
        for (uint256 i = 0; i < n; i++) {
            address alt = vaults[i];
            if (alt == v) continue;
            (bool altOk, bytes memory altPayload) = ICLVault(alt).checker();
            if (altOk) {
                _execute(alt, altPayload);
                return;
            }
        }
        revert NoEligibleVault();
    }

    // ------------------------------------------------------------------------------- internal --

    function _execute(address v, bytes memory payload) internal {
        (bool ok, bytes memory ret) = v.call(payload);
        if (!ok) revert CallFailed(ret);
        emit RebalanceTriggered(v, payload);
    }

    function _selector(bytes memory data) internal pure returns (bytes4 sel) {
        if (data.length < 4) return 0x0;
        assembly { sel := mload(add(data, 32)) }
    }
}
