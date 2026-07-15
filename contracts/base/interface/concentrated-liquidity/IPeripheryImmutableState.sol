// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

/// @title Immutable state
/// @notice Functions that return immutable state of the router
interface IPeripheryImmutableState {
    /// @return Returns the address of the CL factory
    function factory() external view returns (address);
}