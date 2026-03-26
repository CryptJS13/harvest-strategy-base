// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/math/SafeMathUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import "./interface/IStrategy.sol";
import "./interface/IVault.sol";
import "./interface/IController.sol";
import "./interface/IUpgradeSource.sol";
import "./inheritance/ControllableInit.sol";
import "./VaultStorage.sol";
import "./interface/IERC4626.sol";

/**
 * @title VaultV1
 * @dev Yield-optimizing vault with a customizable strategy, supporting deposit, withdrawal, and upgrades.
 * Provides automated reinvestment and governance-controlled parameters.
 * Inherits from `ControllableInit` for governance and controller access, and `VaultStorage` for underlying asset management.
 */
contract VaultV1 is ERC20Upgradeable, IUpgradeSource, ControllableInit, VaultStorage {
  using SafeERC20Upgradeable for IERC20Upgradeable;
  using AddressUpgradeable for address;
  using SafeMathUpgradeable for uint256;

  event Invest(uint256 amount);
  event StrategyAnnounced(address newStrategy, uint256 time);
  event StrategyChanged(address newStrategy, address oldStrategy);

  constructor() {}

  /**
   * @notice Initializes the vault with the specified underlying asset and investment parameters.
   * @param _storage Address of the storage contract.
   * @param _underlying Address of the underlying asset.
   * @param _toInvestNumerator Fraction of the vault's assets to invest in the strategy, numerator.
   * @param _toInvestDenominator Fraction of the vault's assets to invest in the strategy, denominator.
   */
  function initializeVault(
    address _storage,
    address _underlying,
    uint256 _toInvestNumerator,
    uint256 _toInvestDenominator
  ) public initializer {
    require(_toInvestNumerator <= _toInvestDenominator, "Cannot invest more than 100%");
    require(_toInvestDenominator != 0, "Cannot divide by 0");

    __ERC20_init(
      string(abi.encodePacked("FARM_", ERC20Upgradeable(_underlying).symbol())),
      string(abi.encodePacked("f", ERC20Upgradeable(_underlying).symbol()))
    );
    _setDecimals(ERC20Upgradeable(_underlying).decimals());

    ControllableInit.initialize(_storage);

    uint256 _underlyingUnit = 10 ** uint256(ERC20Upgradeable(address(_underlying)).decimals());
    VaultStorage.initialize(
      _underlying,
      _toInvestNumerator,
      _toInvestDenominator,
      _underlyingUnit
    );
  }

  function decimals() public view override returns(uint8) {
    return uint8(_decimals());
  }

  /**
   * @notice Returns the current strategy address.
   * @return Address of the current strategy.
   */
  function strategy() public view returns(address) {
    return _strategy();
  }

  /**
   * @notice Returns the underlying asset address.
   * @return Address of the underlying asset.
   */
  function underlying() public view returns(address) {
    return _underlying();
  }

  /**
   * @notice Returns the unit of the underlying asset.
   * @return Number of decimals for the underlying asset.
   */
  function underlyingUnit() public view returns(uint256) {
    return _underlyingUnit();
  }

  /**
   * @notice Returns the numerator of the vault fraction to invest.
   * @return Vault fraction numerator for investment.
   */
  function vaultFractionToInvestNumerator() public view returns(uint256) {
    return _vaultFractionToInvestNumerator();
  }

  /**
   * @notice Returns the denominator of the vault fraction to invest.
   * @return Vault fraction denominator for investment.
   */
  function vaultFractionToInvestDenominator() public view returns(uint256) {
    return _vaultFractionToInvestDenominator();
  }

  /**
   * @notice Returns the address of the next scheduled implementation for upgrades.
   * @return Address of the next implementation contract.
   */
  function nextImplementation() public view returns(address) {
    return _nextImplementation();
  }

  /**
   * @notice Returns the timestamp for the scheduled upgrade.
   * @return Unix timestamp for when the upgrade is scheduled.
   */
  function nextImplementationTimestamp() public view returns(uint256) {
    return _nextImplementationTimestamp();
  }

  /**
   * @notice Gets the required delay for the next upgrade.
   * @return Delay in seconds for the next upgrade.
   */
  function nextImplementationDelay() public view returns (uint256) {
    return IController(controller()).nextImplementationDelay();
  }

  /**
   * @notice Sets whether the vault should automatically invest on deposit.
   * @param value Boolean to enable or disable automatic investment on deposit.
   */
  function setInvestOnDeposit(bool value) external onlyGovernance {
    _setInvestOnDeposit(value);
  }

  /**
   * @notice Checks if the vault is set to invest on deposit.
   * @return Boolean indicating if automatic investment on deposit is enabled.
   */
  function investOnDeposit() public view returns (bool) {
    return _investOnDeposit();
  }

  function setCompoundOnWithdraw(bool value) external onlyGovernance {
    _setCompoundOnWithdraw(value);
  }

  function compoundOnWithdraw() public view returns (bool) {
    return _compoundOnWithdraw();
  }

  modifier whenStrategyDefined() {
    require(address(strategy()) != address(0), "Strategy must be defined");
    _;
  }

  modifier defense() {
    require(
      (msg.sender == tx.origin) || !IController(controller()).greyList(msg.sender),
      "This smart contract has been grey listed"
    );
    _;
  }

  /**
   * @notice Calls `doHardWork` on the strategy to re-invest funds and claim rewards.
   */
  function doHardWork() whenStrategyDefined onlyControllerOrGovernance external {
    invest();
    IStrategy(strategy()).doHardWork();
  }

  /**
   * @notice Returns the current balance of underlying asset in the vault.
   * @return Balance of underlying asset held by the vault.
   */
  function underlyingBalanceInVault() view public returns (uint256) {
    return IERC20Upgradeable(underlying()).balanceOf(address(this));
  }

  /**
   * @notice Returns the total balance of underlying asset, including invested amount.
   * @return Total underlying asset balance (in vault and invested).
   */
  function underlyingBalanceWithInvestment() view public returns (uint256) {
    if (address(strategy()) == address(0)) {
      return underlyingBalanceInVault();
    }
    return underlyingBalanceInVault().add(IStrategy(strategy()).investedUnderlyingBalance());
  }

  /**
   * @notice Calculates the value per share in terms of the underlying asset.
   * @return Price per full share in terms of the underlying asset.
   */
  function getPricePerFullShare() public view returns (uint256) {
    return totalSupply() == 0
        ? underlyingUnit()
        : underlyingUnit().mul(underlyingBalanceWithInvestment()).div(totalSupply());
  }

  /**
   * @notice Returns the balance of underlying asset for a specific holder, including investment.
   * @param holder Address of the holder.
   * @return Balance of underlying asset, including investment, for the holder.
   */
  function underlyingBalanceWithInvestmentForHolder(address holder) view external returns (uint256) {
    if (totalSupply() == 0) {
      return 0;
    }
    return underlyingBalanceWithInvestment()
        .mul(balanceOf(holder))
        .div(totalSupply());
  }

  /**
   * @notice Gets the next scheduled strategy address for the vault.
   * @return Address of the next strategy.
   */
  function nextStrategy() public view returns (address) {
    return _nextStrategy();
  }

  /**
   * @notice Gets the timestamp for when the next strategy is scheduled to be applied.
   * @return Timestamp of the next strategy update.
   */
  function nextStrategyTimestamp() public view returns (uint256) {
    return _nextStrategyTimestamp();
  }

  /**
   * @notice Checks if the specified strategy can be set.
   * @param _strategy Address of the strategy to check.
   * @return Boolean indicating if the strategy can be set.
   */
  function canUpdateStrategy(address _strategy) public view returns (bool) {
    bool isStrategyNotSetYet = strategy() == address(0);
    bool hasTimelockPassed = block.timestamp > nextStrategyTimestamp() && nextStrategyTimestamp() != 0;
    return isStrategyNotSetYet || (_strategy == nextStrategy() && hasTimelockPassed);
  }

  /**
   * @notice Announces a strategy update to take effect after the delay period.
   * @param _strategy Address of the new strategy.
   */
  function announceStrategyUpdate(address _strategy) public onlyControllerOrGovernance {
    uint256 when = block.timestamp.add(nextImplementationDelay());
    _setNextStrategyTimestamp(when);
    _setNextStrategy(_strategy);
    emit StrategyAnnounced(_strategy, when);
  }

  /**
   * @notice Finalizes or cancels a scheduled strategy update by resetting timestamps.
   */
  function finalizeStrategyUpdate() public onlyControllerOrGovernance {
    _setNextStrategyTimestamp(0);
    _setNextStrategy(address(0));
  }

  /**
   * @notice Sets the vault's strategy to the specified address if the conditions are met.
   * @param _strategy Address of the new strategy.
   */
  function setStrategy(address _strategy) public onlyControllerOrGovernance {
    require(canUpdateStrategy(_strategy), "The strategy exists and switch timelock did not elapse yet");
    require(_strategy != address(0), "new _strategy cannot be empty");
    require(IStrategy(_strategy).underlying() == address(underlying()), "Vault underlying must match Strategy underlying");
    require(IStrategy(_strategy).vault() == address(this), "the strategy does not belong to this vault");

    emit StrategyChanged(_strategy, strategy());
    if (address(_strategy) != address(strategy())) {
      if (address(strategy()) != address(0)) {
        IERC20Upgradeable(underlying()).safeApprove(address(strategy()), 0);
        IStrategy(strategy()).withdrawAllToVault();
      }
      _setStrategy(_strategy);
      IERC20Upgradeable(underlying()).safeApprove(address(strategy()), type(uint256).max);
    }
    finalizeStrategyUpdate();
  }

  /**
   * @notice Sets the investment fraction for the vault.
   * @param numerator Numerator of the fraction.
   * @param denominator Denominator of the fraction.
   */
  function setVaultFractionToInvest(uint256 numerator, uint256 denominator) external onlyGovernance {
    require(denominator > 0, "denominator must be greater than 0");
    require(numerator <= denominator, "denominator must be greater than or equal to the numerator");
    _setVaultFractionToInvestNumerator(numerator);
    _setVaultFractionToInvestDenominator(denominator);
  }

  /**
   * @notice Rebalances the vault by withdrawing all funds and reinvesting.
   */
  function rebalance() external onlyControllerOrGovernance {
    withdrawAll();
    invest();
  }

  /**
   * @notice Returns the amount of underlying asset available for investment in the strategy.
   * @return Amount available for investment.
   */
  function availableToInvestOut() public view returns (uint256) {
    uint256 wantInvestInTotal = underlyingBalanceWithInvestment()
        .mul(vaultFractionToInvestNumerator())
        .div(vaultFractionToInvestDenominator());
    uint256 alreadyInvested = IStrategy(strategy()).investedUnderlyingBalance();
    if (alreadyInvested >= wantInvestInTotal) {
      return 0;
    } else {
      uint256 remainingToInvest = wantInvestInTotal.sub(alreadyInvested);
      return remainingToInvest <= underlyingBalanceInVault()
        ? remainingToInvest : underlyingBalanceInVault();
    }
  }

  /**
   * @notice Internal function to invest funds in the strategy.
   */
  function invest() internal whenStrategyDefined {
    uint256 availableAmount = availableToInvestOut();
    if (availableAmount > 0) {
      IERC20Upgradeable(underlying()).safeTransfer(address(strategy()), availableAmount);
      emit Invest(availableAmount);
    }
  }

  /**
   * @notice Deposits underlying assets in exchange for vault shares.
   * @param amount Amount of underlying assets to deposit.
   * @return minted Number of shares minted.
   */
  function deposit(uint256 amount) external nonReentrant defense returns (uint256 minted) {
    minted = _deposit(amount, msg.sender, msg.sender);
  }

  /**
   * @notice Deposits underlying assets for a specified holder in exchange for shares.
   * @param amount Amount of underlying assets to deposit.
   * @param holder Address to receive the shares.
   * @return minted Number of shares minted.
   */
  function depositFor(uint256 amount, address holder) public nonReentrant defense returns (uint256 minted) {
    minted = _deposit(amount, msg.sender, holder);
  }

  /**
   * @notice Withdraws specified amount of shares in exchange for underlying assets.
   * @param shares Amount of shares to redeem.
   * @return amtUnderlying Amount of underlying assets received.
   */
  function withdraw(uint256 shares) external nonReentrant returns (uint256 amtUnderlying) {
    amtUnderlying = _withdraw(shares, msg.sender, msg.sender);
  }

  /**
   * @notice Withdraws all assets from the strategy to the vault.
   */
  function withdrawAll() public onlyControllerOrGovernance whenStrategyDefined {
    IStrategy(strategy()).withdrawAllToVault();
  }

  /**
   * @notice Internal function to deposit underlying assets and mint shares.
   * @param amount Amount of underlying assets to deposit.
   * @param sender Address providing the assets.
   * @param beneficiary Address to receive the shares.
   * @return Amount of shares minted.
   */
  function _deposit(uint256 amount, address sender, address beneficiary) internal returns (uint256) {
    require(amount > 0, "Cannot deposit 0");
    require(beneficiary != address(0), "holder must be defined");

    address _strategy = strategy();
    IStrategy(_strategy).preInteract();
    uint256 balanceBefore = underlyingBalanceWithInvestment();

    IERC20Upgradeable(underlying()).safeTransferFrom(sender, address(this), amount);    
    if (investOnDeposit()) {
      invest();
      IStrategy(_strategy).doHardWork();
    }

    uint256 balanceAfter = underlyingBalanceWithInvestment();
    uint256 actualAmount = balanceAfter.sub(balanceBefore);

    uint256 toMint = totalSupply() == 0
        ? actualAmount
        : actualAmount.mul(totalSupply()).div(underlyingBalanceWithInvestment().sub(actualAmount));
    _mint(beneficiary, toMint);

    emit IERC4626.Deposit(sender, beneficiary, actualAmount, toMint);
    return toMint;
  }

  /**
   * @notice Internal function to withdraw shares and receive underlying assets.
   * @param numberOfShares Amount of shares to redeem.
   * @param receiver Address to receive the underlying assets.
   * @param owner Address holding the shares to redeem.
   * @return Amount of underlying assets received.
   */
  function _withdraw(uint256 numberOfShares, address receiver, address owner) internal returns (uint256) {
    require(totalSupply() > 0, "Vault has no shares");
    require(numberOfShares > 0, "numberOfShares must be greater than 0");
    uint256 totalSupply = totalSupply();

    address sender = msg.sender;
    if (sender != owner) {
      uint256 currentAllowance = allowance(owner, sender);
      if (currentAllowance != type(uint256).max) {
        require(currentAllowance >= numberOfShares, "ERC20: transfer amount exceeds allowance");
        _approve(owner, sender, currentAllowance - numberOfShares);
      }
    }
    _burn(owner, numberOfShares);

    address _strategy = strategy();
    IStrategy(_strategy).preInteract();

    if (compoundOnWithdraw()) {
      IStrategy(_strategy).doHardWork();
    }

    uint256 underlyingAmountToWithdraw = underlyingBalanceWithInvestment()
        .mul(numberOfShares)
        .div(totalSupply);
    if (underlyingAmountToWithdraw > underlyingBalanceInVault()) {
      if (numberOfShares == totalSupply) {
        IStrategy(_strategy).withdrawAllToVault();
      } else {
        uint256 missing = underlyingAmountToWithdraw.sub(underlyingBalanceInVault());
        IStrategy(_strategy).withdrawToVault(missing);
      }
      underlyingAmountToWithdraw = underlyingBalanceInVault();
    }

    IERC20Upgradeable(underlying()).safeTransfer(receiver, underlyingAmountToWithdraw);
    emit IERC4626.Withdraw(sender, receiver, owner, underlyingAmountToWithdraw, numberOfShares);
    return underlyingAmountToWithdraw;
  }

  /**
   * @notice Schedules an upgrade for the vault.
   * @param impl Address of the new implementation.
   */
  function scheduleUpgrade(address impl) public onlyGovernance {
    _setNextImplementation(impl);
    _setNextImplementationTimestamp(block.timestamp.add(nextImplementationDelay()));
  }

  /**
   * @notice Checks if an upgrade is ready and returns the next implementation.
   * @return Boolean indicating if an upgrade is scheduled and address of the next implementation.
   */
  function shouldUpgrade() external view override returns (bool, address) {
    return (
      nextImplementationTimestamp() != 0
        && block.timestamp > nextImplementationTimestamp()
        && nextImplementation() != address(0),
      nextImplementation()
    );
  }

  /**
   * @notice Finalizes an upgrade by resetting the scheduled implementation and timestamp.
   */
  function finalizeUpgrade() external override onlyGovernance {
    _setDecimals(ERC20Upgradeable(underlying()).decimals());
    _setNextImplementation(address(0));
    _setNextImplementationTimestamp(0);
  }

  uint256[50] private ______gap;
}
