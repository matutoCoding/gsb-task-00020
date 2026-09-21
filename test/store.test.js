const test = require('node:test');
const assert = require('node:assert/strict');

// 给 store 造一个 localStorage 桩
const mem = {};
global.localStorage = {
  getItem: k => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; }
};
const Store = require('../js/store.js');
const GS = require('../js/engine.js');

function reset() { for (const k in mem) delete mem[k]; Store.clearAll(); }

test('规则5工作流: 建车次日开单按次日挂牌价', () => {
  reset();
  const today = GS.todayStr();
  const tom = GS.todayStr(new Date(Date.now() + 86400000));
  Store.setPrice(today, 2000);
  Store.setPrice(tom, 1900);
  const d = Store.createDraft('吉A-1', '张三');
  Store.upsertTrip(d.id, { gross: 20000, tare: 8000, moistureLab: 14, labNo: 'A1' });
  // 模拟跨零点：把在算车的计价日改成明天
  const st = Store.get();
  let settle = GS.settleDraft(Store.getDraft(d.id), st.config, st.prices);
  assert.equal(settle.price, 2000);
  Store.updateDraft(d.id, { businessDate: tom, settleDate: tom });
  settle = GS.settleDraft(Store.getDraft(d.id), st.config, st.prices);
  assert.equal(settle.price, 1900);
  const bill = Store.issueBill(d.id, settle);
  assert.equal(bill.priceDate, tom);
  assert.equal(bill.amount, GS.roundAmount(12 * 1900));
});

test('规则9工作流: 改系数后旧趟次仍按旧系数，新趟次按新系数', () => {
  reset();
  const d = Store.createDraft('吉A-2', '李四');
  Store.upsertTrip(d.id, { gross: 20000, tare: 8000, moistureLab: 16, labNo: 'A2' });
  Store.updateConfig({ moistureCoeff: 1.5 });
  Store.upsertTrip(d.id, { gross: 18000, tare: 8000, moistureLab: 16, labNo: 'A3' });
  const st = Store.get();
  const draft = Store.getDraft(d.id);
  const s = GS.settleDraft(draft, st.config, st.prices);
  assert.equal(s.tripResults[0].moisture.rate, 0.02);
  assert.equal(s.tripResults[1].moisture.rate, 0.03);
});

test('规则10工作流: 已开单据不可变，重算另开新单且记原号', () => {
  reset();
  const d0 = Store.createDraft('吉A-3', '王五');
  Store.upsertTrip(d0.id, { gross: 20000, tare: 8000, moistureLab: 16, labNo: 'A4' });
  const st = Store.get();
  let settle = GS.settleDraft(Store.getDraft(d0.id), st.config, st.prices);
  // 无当天价时不能开
  assert.equal(settle.ready, false);
  Store.setPrice(GS.todayStr(), 2000);
  settle = GS.settleDraft(Store.getDraft(d0.id), st.config, st.prices);
  const b1 = Store.issueBill(d0.id, settle);
  assert.ok(b1.billNo);
  assert.equal(Store.getDraft(d0.id) == null, true); // 开单后在算车消失

  // 规则11：重算从第一趟重新走——只有车与司机，趟次为空
  const nd = Store.createRecalcDraft(b1);
  assert.equal(nd.plate, '吉A-3');
  assert.equal(nd.recalcOf, b1.billNo);
  assert.equal(nd.trips.length, 0);

  // 重录趟次（假设复检后水分14）并再开一张
  Store.upsertTrip(nd.id, { gross: 20000, tare: 8000, moistureLab: 14, labNo: 'A4R' });
  const s2 = GS.settleDraft(Store.getDraft(nd.id), Store.get().config, Store.get().prices);
  const b2 = Store.issueBill(nd.id, s2);
  assert.notEqual(b2.billNo, b1.billNo);
  assert.equal(b2.recalcOf, b1.billNo);

  // 原单内容原样保留
  const bills = Store.get().bills;
  const orig = bills.find(b => b.billNo === b1.billNo);
  assert.equal(orig.trips[0].moistureLab, 16);
  assert.equal(orig.amount, b1.amount);
});

test('规则4工作流: 双水分未定不能开单，点定后可开', () => {
  reset();
  Store.setPrice(GS.todayStr(), 2000);
  const d = Store.createDraft('吉A-4', '赵六');
  Store.upsertTrip(d.id, { gross: 20000, tare: 8000, moistureLab: 16, moistureCheck: 17, labNo: 'A5' });
  const st = Store.get();
  let s = GS.settleDraft(Store.getDraft(d.id), st.config, st.prices);
  assert.equal(s.ready, false);
  assert.equal(s.note, 'MOISTURE_PENDING');
  // 不允许系统自己挑：仍为 pending
  s = GS.settleDraft(Store.getDraft(d.id), st.config, st.prices);
  assert.equal(s.ready, false);
  // 人工点采用复检
  const t = Store.getDraft(d.id).trips[0];
  Store.upsertTrip(d.id, Object.assign({}, t, { moistureSource: 'check' }));
  s = GS.settleDraft(Store.getDraft(d.id), st.config, st.prices);
  assert.equal(s.ready, true);
  assert.equal(s.tripResults[0].moisture.value, 17);
});

test('规则8工作流: 两趟各按各化验单折干后合计', () => {
  reset();
  Store.setPrice(GS.todayStr(), 2000);
  const d = Store.createDraft('吉A-5', '孙七');
  Store.upsertTrip(d.id, { gross: 20000, tare: 8000, moistureLab: 15, labNo: 'X1' });
  Store.upsertTrip(d.id, { gross: 10000, tare: 4000, moistureLab: 18, labNo: 'X2' });
  const st = Store.get();
  const s = GS.settleDraft(Store.getDraft(d.id), st.config, st.prices);
  const expect = GS.roundWeightKg(12000 * 0.99 + 6000 * 0.96);
  assert.equal(s.settleKg, expect);
});
