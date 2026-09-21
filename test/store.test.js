const test = require("node:test");
const assert = require("node:assert/strict");

globalThis.DRY = require("../js/domain.js");
const Store = require("../js/store.js");

function freshState() {
  const s = Store.createInitialState();
  Store.setPrice(s, "2026-09-22", 2000);
  Store.setPrice(s, "2026-09-23", 2200);
  return s;
}

function addReadyLoad(s, now) {
  const load = Store.addLoad(s, { plateNo: "吉A12345", driver: "老王" });
  Store.addTrip(s, load.id, {
    grossKg: 20000,
    tareKg: 8000,
    weighedAt: now || "2026-09-22T10:00:00+08:00",
    labSheetNo: "HY-1",
    labMoisture: 15,
    impurityPct: 1,
    bulkValue: 720,
  });
  return load;
}

// 第 5 条：挂牌价只算当天，跨零点落到次日价重算
test("规则5 未开单的车跨零点按次日价重算", () => {
  const s = freshState();
  const load = addReadyLoad(s);
  const before = Store.calcLoadById(s, load.id, new Date("2026-09-22T23:59:00+08:00"));
  assert.equal(before.pricePerTon, 2000);

  const changed = Store.rollover(s, new Date("2026-09-23T00:05:00+08:00"));
  assert.equal(changed, true);
  const after = Store.calcLoadById(s, load.id, new Date("2026-09-23T00:05:00+08:00"));
  assert.equal(after.pricePerTon, 2200);

  // 开了单的车价格锁死，不再滚
  Store.issueBill(s, load.id, new Date("2026-09-23T08:00:00+08:00"));
  Store.rollover(s, new Date("2026-09-24T08:00:00+08:00"));
  const bill = s.bills[0];
  assert.equal(bill.pricePerTon, 2200);
});

// 第 7 条：单位切换不影响已开单（快照 unit）
test("规则7 已开单不随单位切换而变动", () => {
  const s = freshState();
  const load = addReadyLoad(s);
  s.unit = "jin";
  const bill = Store.issueBill(s, load.id, new Date("2026-09-22T11:00:00+08:00"));
  assert.equal(bill.unit, "jin");
  assert.equal(bill.pricePerTon, 2000); // 内部始终每吨
  assert.equal(bill.amount, 23520); // 12000*0.98kg, 2000元/吨

  s.unit = "ton";
  const again = s.bills.find((b) => b.id === bill.id);
  assert.equal(again.unit, "jin");
  assert.equal(again.amount, 23520);
});

// 第 10 条：已开单不可改；重算另开新单并写明原单号
test("规则10 单子打出后不能改，重算另开并引用原号", () => {
  const s = freshState();
  const load = addReadyLoad(s);
  const bill = Store.issueBill(s, load.id, new Date("2026-09-22T11:00:00+08:00"));
  assert.throws(() => Store.addTrip(s, load.id, {}), /已开单/);
  assert.throws(() => Store.removeTrip(s, load.id, load.trips[0].id), /已开单/);

  const edited = load.trips.map((t) => Object.assign({}, t, { labMoisture: 14 }));
  const nb = Store.reissueFromFirstTrip(
    s,
    bill.id,
    edited,
    new Date("2026-09-23T09:00:00+08:00")
  );
  assert.equal(nb.reissueOf, bill.billNo);
  assert.equal(bill.status, "superseded");
  assert.equal(bill.supersededBy, nb.billNo);
  assert.notEqual(nb.billNo, bill.billNo);
  // 水分改安全后金额变大
  assert.ok(nb.amount > bill.amount);
});

// 第 11 条：重算只能从第一趟开始，趟数必须对齐
test("规则11 重算必须从第一趟逐趟重走", () => {
  const s = freshState();
  const load = addReadyLoad(s);
  Store.addTrip(s, load.id, {
    grossKg: 18000,
    tareKg: 8000,
    weighedAt: "2026-09-22T14:00:00+08:00",
    labSheetNo: "HY-2",
    labMoisture: 16,
    impurityPct: 1,
    bulkValue: 720,
  });
  const bill = Store.issueBill(s, load.id, new Date("2026-09-22T18:00:00+08:00"));

  // 只重走第二趟 -> 拒绝
  const onlySecond = [Object.assign({}, load.trips[1])];
  assert.throws(
    () => Store.reissueFromFirstTrip(s, bill.id, onlySecond, new Date("2026-09-23T09:00:00+08:00")),
    /第一趟/
  );

  // 两趟按顺序重走 -> 成功，且第一趟化验单仍是 HY-1
  const edited = load.trips.map((t) => Object.assign({}, t));
  const nb = Store.reissueFromFirstTrip(s, bill.id, edited, new Date("2026-09-23T09:00:00+08:00"));
  assert.equal(nb.trips[0].labSheetNo, "HY-1");
  assert.equal(nb.trips.length, 2);
});

// 第 4 条联动：水分未点定不能开单
test("规则4联动 水分冲突未点定时不能开单", () => {
  const s = freshState();
  const load = Store.addLoad(s, { plateNo: "吉B00000" });
  Store.addTrip(s, load.id, {
    grossKg: 20000,
    tareKg: 8000,
    labSheetNo: "HY-1",
    labMoisture: 15,
    recheckMoisture: 18,
    impurityPct: 1,
    bulkValue: 720,
  });
  assert.throws(
    () => Store.issueBill(s, load.id, new Date("2026-09-22T11:00:00+08:00")),
    /点定/
  );
  Store.updateTrip(s, load.id, load.trips[0].id, { moistureChoice: "lab" });
  const bill = Store.issueBill(s, load.id, new Date("2026-09-22T11:05:00+08:00"));
  assert.match(bill.trips[0].moistureSource, /化验室/);
});

// 没有当天挂牌价不能开单
test("规则5联动 无当日挂牌价不能开单", () => {
  const s = freshState();
  const load = addReadyLoad(s, "2026-09-25T10:00:00+08:00");
  assert.throws(
    () => Store.issueBill(s, load.id, new Date("2026-09-25T11:00:00+08:00")),
    /挂牌价/
  );
});
