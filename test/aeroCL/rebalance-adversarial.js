const CLRebalanceHelper = artifacts.require("CLRebalanceHelper");
const MockCLPool = artifacts.require("MockCLPool");

describe("CL rebalance adversarial guards", function() {
  let helper;
  let pool;
  const Q96 = web3.utils.toBN("79228162514264337593543950336");

  beforeEach(async function() {
    helper = await CLRebalanceHelper.new();
    pool = await MockCLPool.new();
    await pool.setSlot0(Q96.toString(), 0);
    await pool.setObserve("0", "0"); // TWAP tick = 0 => 1:1
  });

  it("should cap amountIn with maxSwapBps under token0 excess", async function() {
    const plan = await helper.planSwap(
      pool.address,
      "1000",
      "100",
      2500,
      100,
      900,
      0
    );

    assert.equal(plan.shouldSwap, true, "Expected swap plan");
    assert.equal(plan.zeroForOne, true, "Expected token0->token1 path");
    assert.equal(plan.amountIn.toString(), "250", "Expected maxSwapBps cap to apply");
    assert.equal(plan.minOut.toString(), "247", "Expected slippage-adjusted minOut");
  });

  it("should plan reverse direction under token1 excess", async function() {
    const plan = await helper.planSwap(
      pool.address,
      "100",
      "1000",
      2500,
      100,
      900,
      0
    );

    assert.equal(plan.shouldSwap, true, "Expected swap plan");
    assert.equal(plan.zeroForOne, false, "Expected token1->token0 path");
    assert.equal(plan.amountIn.toString(), "250", "Expected maxSwapBps cap to apply");
    assert.equal(plan.minOut.toString(), "247", "Expected slippage-adjusted minOut");
  });

  it("should return no swap when balances are already balanced", async function() {
    const plan = await helper.planSwap(
      pool.address,
      "1000",
      "1000",
      2500,
      100,
      900,
      0
    );

    assert.equal(plan.shouldSwap, false, "Expected no swap for balanced state");
    assert.equal(plan.amountIn.toString(), "0");
    assert.equal(plan.minOut.toString(), "0");
  });

  it("should revert when spot deviates from TWAP beyond allowed bps", async function() {
    // Spot remains 1:1, but TWAP is moved to tick 10000 over 900 sec.
    await pool.setObserve("0", "9000000");

    let failed = false;
    try {
      await helper.planSwap(
        pool.address,
        "1000000000000000000",
        "1000000000000000000",
        2500,
        100,
        900,
        10
      );
    } catch (e) {
      failed = true;
    }
    assert.equal(failed, true, "Expected TWAP deviation guard to revert");
  });
});
