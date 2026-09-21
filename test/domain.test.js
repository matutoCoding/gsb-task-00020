const test = require("node:test");
const assert = require("node:assert/strict");

globalThis.DRY = require("../js/domain.js");
const D = globalThis.DRY;

function tripInput(over = {}) {
  return Object.assign(
    {
      id: "T1",
      grossKg: 20000,
      tareKg: 8000,
      weighedAt: "2026-09-22T10:00:00+08:00",
      labSheetNo: "HY-1",
      labMoisture: 14,
      impurityPct: 1,
      bulkValue: 720,
    },
    over
  );
}

const versions = {
  moisture: [{ effectiveAt: "2000-01-01T00:00:00+08:00", coefficient: 1 }],
  impurity: [{ effectiveAt: "2000-01-01T00:00:00+08:00", coefficient: 1 }],
};

// 第 1 条：毛重减皮重得净重
test("规则1 毛重减皮重得净重", () => {
  const r = D.calcTrip(tripInput(), D.defaultParams(), versions);
  assert.equal(r.netKg, 12000);
});

// 第 2 条：水分分三段
test("规则2 安全水分内不扣、中间段乘系数、超标拒收", () => {
  const p = D.defaultParams();
  const safe = D.calcTrip(tripInput({ labMoisture: 13 }), p, versions);
  assert.equal(safe.band, "safe");
  assert.equal(safe.moistureDeductPct, 0);
  assert.equal(safe.settledKg, 12000);

  // 15%：超安全线 1 个点 = 2 档 × 1% → 扣 2%
  const mid = D.calcTrip(tripInput({ labMoisture: 15 }), p, versions);
  assert.equal(mid.band, "middle");
  assert.equal(mid.moistureDeductPct, 2);

  // 系数改为 1.5：同一水分扣 3%
  const midCoef = D.calcTrip(tripInput({ labMoisture: 15 }), p, {
    moisture: [{ effectiveAt: "2000-01-01T00:00:00+08:00", coefficient: 1.5 }],
    impurity: versions.impurity,
  });
  assert.equal(midCoef.moistureDeductPct, 3);

  const rej = D.calcTrip(tripInput({ labMoisture: 30.5 }), p, versions);
  assert.equal(rej.band, "reject");
  assert.equal(rej.rejected, true);
  assert.equal(rej.settledKg, 0);
});

// 第 3 条：水分档、容重等级、杂质三样共同决定，连乘联动
test("规则3 三样扣率连乘，动一样另两样扣量跟着变", () => {
  const p = D.defaultParams();
  // 15%水扣2%，杂质1.5%超0.5→1档扣1%，容重二等扣1%
  const t = D.calcTrip(
    tripInput({ labMoisture: 15, impurityPct: 1.5, bulkValue: 700 }),
    p,
    versions
  );
  assert.equal(t.grade, "二等");
  // 12000 * 0.98 * 0.99 * 0.99 = 11525.976 → 11526（保留0.5kg）
  assert.equal(t.settledKg, 11526);

  // 水分变安全：杂质与容重的扣量基数也跟着变大
  const t2 = D.calcTrip(
    tripInput({ labMoisture: 14, impurityPct: 1.5, bulkValue: 700 }),
    p,
    versions
  );
  assert.ok(t2.settledKg > t.settledKg);
});

// 第 4 条：化验室与磅房水分对不上，等人点，系统不自己挑
test("规则4 水分冲突时不自动选用，必须人工点定", () => {
  const p = D.defaultParams();
  const conflict = D.calcTrip(
    tripInput({ labMoisture: 15, recheckMoisture: 17 }),
    p,
    versions
  );
  assert.equal(conflict.moistureStatus.ready, false);
  assert.equal(conflict.moistureStatus.conflict, true);
  assert.ok(conflict.errors.length > 0);

  const picked = D.calcTrip(
    tripInput({ labMoisture: 15, recheckMoisture: 17, moistureChoice: "recheck" }),
    p,
    versions
  );
  assert.equal(picked.moisture, 17);
  assert.match(picked.moistureSource, /磅房/);
});

// 第 8 条：一车两趟，净重相加，水分各按各化验单
test("规则8 多趟净重合并，水分各走各化验单", () => {
  const p = D.defaultParams();
  const load = {
    id: "L1",
    basis: "dry",
    previewAt: "2026-09-22T10:00:00+08:00",
    trips: [
      tripInput({ id: "a", grossKg: 20000, tareKg: 8000, labMoisture: 14, labSheetNo: "HY-1" }),
      tripInput({ id: "b", grossKg: 18000, tareKg: 8000, labMoisture: 15, labSheetNo: "HY-2" }),
    ],
  };
  const calc = D.calcLoad(load, p, versions, () => 2000);
  assert.equal(calc.trips[0].netKg, 12000);
  assert.equal(calc.trips[1].netKg, 10000);
  assert.equal(calc.totalNetKg, 22000);
  assert.equal(calc.trips[0].moistureDeductPct, 0);
  assert.equal(calc.trips[1].moistureDeductPct, 2);
  // 12000 + 10000*0.98*0.99*0.99（二等杂质等）—— 这里杂质1%容重一等，第二趟只扣水
});

// 第 6 条：湿基/干基报价，金额相同；并标出化验单
test("规则6 湿基干基切换金额不变，化验单随趟标出", () => {
  const p = D.defaultParams();
  const load = {
    id: "L1",
    basis: "dry",
    previewAt: "2026-09-22T10:00:00+08:00",
    trips: [tripInput({ labSheetNo: "HY-9", labMoisture: 15 })],
  };
  const dry = D.calcLoad(load, p, versions, () => 2000);
  const qDry = D.quoteForBasis(dry);
  assert.equal(qDry.basis, "dry");
  const wetLoad = Object.assign({}, load, { basis: "wet" });
  const wet = D.calcLoad(wetLoad, p, versions, () => 2000);
  const qWet = D.quoteForBasis(wet);
  assert.equal(qWet.basis, "wet");
  assert.equal(qWet.weightKg, 12000); // 湿基报全部净重
  assert.ok(Math.abs(qWet.amount - qDry.amount) < 0.01); // 金额一致
  assert.equal(dry.trips[0].labSheetUsed, "HY-9");
});

// 第 7 条：每吨/每斤换算
test("规则7 每吨与每斤互转", () => {
  assert.equal(D.perTonToPerJin(2000), 1); // 2000元/吨 = 1元/斤
  assert.equal(D.perJinToPerTon(1.2), 2400);
});

// 第 9 条：系数按过磅时刻取版本
test("规则9 改系数只影响之后过磅的车", () => {
  const list = [
    { effectiveAt: "2026-09-01T00:00:00+08:00", coefficient: 1 },
    { effectiveAt: "2026-09-20T00:00:00+08:00", coefficient: 1.5 },
  ];
  assert.equal(D.coefficientAt(list, "2026-09-19T23:59:00+08:00"), 1);
  assert.equal(D.coefficientAt(list, "2026-09-20T00:01:00+08:00"), 1.5);

  const p = D.defaultParams();
  const oldTrip = D.calcTrip(
    tripInput({ labMoisture: 15, weighedAt: "2026-09-19T10:00:00+08:00" }),
    p,
    { moisture: list, impurity: versions.impurity }
  );
  const newTrip = D.calcTrip(
    tripInput({ labMoisture: 15, weighedAt: "2026-09-21T10:00:00+08:00" }),
    p,
    { moisture: list, impurity: versions.impurity }
  );
  assert.equal(oldTrip.moistureDeductPct, 2);
  assert.equal(newTrip.moistureDeductPct, 3);
});
