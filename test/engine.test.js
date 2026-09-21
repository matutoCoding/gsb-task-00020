const test = require('node:test');
const assert = require('node:assert/strict');
const GS = require('../js/engine.js');

const cfg = GS.defaultConfig();

function trip(o) {
  return Object.assign({ gross: 0, tare: 0, moistureLab: null, labNo: '' }, o);
}

test('规则1: 毛重减皮重得净重', () => {
  const r = GS.evaluateTrip(trip({ gross: 20000, tare: 8000, moistureLab: 13 }), cfg);
  assert.equal(r.net, 12000);
});

test('规则2: 安全水分以内不扣；中间段乘扣量系数；超标拒收', () => {
  assert.equal(GS.moistureRate(14, cfg), 0);
  assert.equal(GS.moistureRate(13, cfg), 0);
  assert.ok(Math.abs(GS.moistureRate(15, cfg) - 0.01) < 1e-9); // 超1点×1.0%
  assert.ok(Math.abs(GS.moistureRate(18.5, cfg) - 0.045) < 1e-9);
  assert.equal(GS.moistureClass(20, cfg), 'reject');
  assert.equal(GS.moistureRate(20, cfg), null);

  const rj = GS.evaluateTrip(trip({ gross: 20000, tare: 8000, moistureLab: 20.5 }), cfg);
  assert.equal(rj.rejected, true);
});

test('规则3: 水分档×容重等级×杂质含率联动决定结算重量', () => {
  // 12000kg, 水16(扣2%), 容重660(二等扣1%), 杂质2%(超1点扣1%)
  const r = GS.evaluateTrip(trip({ gross: 20000, tare: 8000, moistureLab: 16, density: 660, impurity: 2 }), cfg);
  const expect = 12000 * 0.98 * 0.99 * 0.99;
  assert.equal(r.settledKg, GS.roundWeightKg(expect));
  // 动水分一样，容重杂质的扣率不变、重新联动
  const r2 = GS.evaluateTrip(trip({ gross: 20000, tare: 8000, moistureLab: 17, density: 660, impurity: 2 }), cfg);
  assert.ok(r2.settledKg < r.settledKg);
  assert.equal(r2.density.rate, 0.01);
  assert.equal(r2.impurity.rate, 0.01);
});

test('规则4: 化验室与磅房水分不一致时并排待定，不自动挑', () => {
  const t = trip({ gross: 20000, tare: 8000, moistureLab: 16, moistureCheck: 17 });
  const pending = GS.evaluateTrip(t, cfg);
  assert.equal(pending.reason, 'MOISTURE_PENDING');
  assert.equal(pending.settledKg, 0);
  // 点了采用化验单
  const pick = GS.evaluateTrip(Object.assign({}, t, { moistureSource: 'lab' }), cfg);
  assert.equal(pick.moisture.value, 16);
  const pick2 = GS.evaluateTrip(Object.assign({}, t, { moistureSource: 'check' }), cfg);
  assert.equal(pick2.moisture.value, 17);
});

test('规则5: 只用当天挂牌价，跨零点按第二天价重算', () => {
  const prices = { '2026-09-21': 2000, '2026-09-22': 1980 };
  const d = { settleDate: '2026-09-21', trips: [trip({ gross: 20000, tare: 8000, moistureLab: 14 })] };
  const s1 = GS.settleDraft(d, cfg, prices);
  assert.equal(s1.price, 2000);
  assert.equal(s1.amount, GS.roundAmount(12 * 2000));
  const s2 = GS.settleDraft(Object.assign({}, d, { settleDate: '2026-09-22' }), cfg, prices);
  assert.equal(s2.price, 1980);
  assert.equal(s2.amount, GS.roundAmount(12 * 1980));
  // 当天没价不能开单
  const s3 = GS.settleDraft(Object.assign({}, d, { settleDate: '2026-09-23' }), cfg, prices);
  assert.equal(s3.ready, false);
  assert.equal(s3.note, 'NO_PRICE');
});

test('规则6: 湿基改干基换算并保留化验单来源', () => {
  assert.ok(Math.abs(GS.wetToDryBasis(20) - 25) < 1e-9);
  assert.ok(Math.abs(GS.dryToWetBasis(25) - 20) < 1e-9);
  const r = GS.evaluateTrip(trip({ gross: 20000, tare: 8000, moistureLab: 16, labNo: 'HY-88' }), cfg);
  assert.equal(r.labNo, 'HY-88');
});

test('规则7: 单价每斤与每吨互转 (1元/斤=2000元/吨)', () => {
  assert.equal(GS.yuanPerJinToPerTon(1), 2000);
  assert.equal(GS.yuanPerTonToPerJin(2000), 1);
});

test('规则8: 一车两趟，净重各自折干后相加', () => {
  const d = { settleDate: '2026-09-22', trips: [
    trip({ gross: 20000, tare: 8000, moistureLab: 16, labNo: 'A' }),
    trip({ gross: 18000, tare: 8000, moistureLab: 18, labNo: 'B' })
  ]};
  const prices = { '2026-09-22': 2000 };
  const s = GS.settleDraft(d, cfg, prices);
  const expect = GS.roundWeightKg(12000 * 0.98 + 10000 * 0.96);
  assert.equal(s.settleKg, expect);
  assert.equal(s.amount, GS.roundAmount(expect / 1000 * 2000));
});

test('规则9: 扣量系数版本——过磅时点快照，改后不溯及既往', () => {
  const oldCfg = Object.assign({}, cfg, { moistureCoeff: 1.0 });
  const newCfg = Object.assign({}, cfg, { moistureCoeff: 1.5 });
  const oldTrip = Object.assign(trip({ gross: 20000, tare: 8000, moistureLab: 16 }), { configSnapshot: oldCfg });
  const sOld = GS.evaluateTrip(oldTrip, newCfg); // 即使传入新配置
  assert.equal(sOld.moisture.rate, 0.02);
  const newTrip = trip({ gross: 20000, tare: 8000, moistureLab: 16 });
  const sNew = GS.evaluateTrip(newTrip, newCfg);
  assert.equal(sNew.moisture.rate, 0.03);
});

test('规则2扩展: 任一趌超标整车拒收，金额为0', () => {
  const d = { settleDate: '2026-09-22', trips: [
    trip({ gross: 20000, tare: 8000, moistureLab: 16 }),
    trip({ gross: 18000, tare: 8000, moistureLab: 21 })
  ]};
  const s = GS.settleDraft(d, cfg, { '2026-09-22': 2000 });
  assert.equal(s.rejected, true);
  assert.equal(s.amount, 0);
});

test('规则10/11在应用层: 拒收单仍取当天价但金额0', () => {
  const d = { settleDate: '2026-09-22', trips: [trip({ gross: 20000, tare: 8000, moistureLab: 22 })] };
  const s = GS.settleDraft(d, cfg, { '2026-09-22': 2000 });
  assert.equal(s.ready, true);
  assert.equal(s.price, 2000);
  assert.equal(s.amount, 0);
});
