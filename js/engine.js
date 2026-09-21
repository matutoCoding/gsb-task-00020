/* 潮粮折干结算核心引擎 —— 纯函数，浏览器与 Node 共用 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 默认挂牌标准（可在“标准设置”里改） ----------
  function defaultConfig() {
    return {
      grainName: '玉米',
      safeMoisture: 14.0,   // 安全水分 %，以内不扣
      rejectMoisture: 20.0, // 超标水分 %，达到即拒收
      moistureCoeff: 1.0,   // 中间段每超 1 个水分点扣 1.0%（按点折）
      baseImpurity: 1.0,    // 基准杂质 %，以内不扣
      impurityCoeff: 1.0,   // 杂质每超 1 个点扣 1.0%
      densityGrades: [      // 容重 g/L，从高到低；未命中最后一档
        { min: 690, deduct: 0.0, label: '一等' },
        { min: 660, deduct: 0.01, label: '二等' },
        { min: 630, deduct: 0.02, label: '三等' },
        { min: 0,   deduct: 0.04, label: '等外' }
      ]
    };
  }

  function round(n, d) {
    var f = Math.pow(10, d);
    return Math.round((n + Number.EPSILON) * f) / f;
  }
  function roundWeightKg(kg) { return round(kg, 0); }       // 结算重量精确到公斤
  function roundAmount(yuan) { return round(yuan, 2); }    // 金额精确到分

  function moistureClass(m, cfg) {
    if (m <= cfg.safeMoisture) return 'safe';
    if (m >= cfg.rejectMoisture) return 'reject';
    return 'middle';
  }

  // 水分扣率：安全段 0；中间段 超出点数×系数%；超标段拒收
  function moistureRate(m, cfg) {
    var cls = moistureClass(m, cfg);
    if (cls === 'safe') return 0;
    if (cls === 'reject') return null;
    return Math.max(0, m - cfg.safeMoisture) * cfg.moistureCoeff / 100;
  }

  function densityGrade(density, cfg) {
    if (density == null || isNaN(density)) {
      return { deduct: 0, label: '未检' };
    }
    for (var i = 0; i < cfg.densityGrades.length; i++) {
      if (density >= cfg.densityGrades[i].min) {
        return { deduct: cfg.densityGrades[i].deduct, label: cfg.densityGrades[i].label };
      }
    }
    var last = cfg.densityGrades[cfg.densityGrades.length - 1];
    return { deduct: last.deduct, label: last.label };
  }

  function impurityRate(imp, cfg) {
    if (imp == null || isNaN(imp)) return 0;
    return Math.max(0, imp - cfg.baseImpurity) * cfg.impurityCoeff / 100;
  }

  // 湿基 -> 干基：M_dry = M_wet / (1 - M_wet)
  function wetToDryBasis(mWet) { return 100 * mWet / (100 - mWet); }
  // 干基 -> 湿基
  function dryToWetBasis(mDry) { return 100 * mDry / (100 + mDry); }

  // 单趟试算。trip: {gross, tare, moistureLab, moistureCheck, moistureSource,
  //                  density, impurity, labNo, weighedAt}
  // 返回 {net, settledKg, rejected, moisture:{value,source,cls,rate}, density:{label,rate},
  //        impurity:{value,rate}, rate, note}
  function evaluateTrip(trip, cfg) {
    cfg = trip.configSnapshot || cfg; // 规则9：按过磅时点的系数走
    var net = (Number(trip.gross) || 0) - (Number(trip.tare) || 0);
    var res = {
      gross: Number(trip.gross) || 0,
      tare: Number(trip.tare) || 0,
      net: round(net, 0),
      labNo: trip.labNo || '',
      weighedAt: trip.weighedAt || null,
      moisture: { lab: trip.moistureLab, check: trip.moistureCheck, value: null, source: null, cls: null, rate: null },
      density: { value: trip.density, label: null, rate: 0 },
      impurity: { value: trip.impurity, rate: 0 },
      factor: 1,
      settledKg: 0,
      rejected: false,
      reason: null
    };

    // 规则4：两个水分对不上时并排等人点；没点不算账
    var m;
    if (trip.moistureCheck != null && trip.moistureCheck !== '' &&
        Number(trip.moistureCheck) !== Number(trip.moistureLab)) {
      if (trip.moistureSource === 'lab' || trip.moistureSource === 'check') {
        m = Number(trip.moistureSource === 'lab' ? trip.moistureLab : trip.moistureCheck);
      } else {
        res.reason = 'MOISTURE_PENDING';
        return res;
      }
    } else {
      m = trip.moistureLab == null || trip.moistureLab === '' ? NaN : Number(trip.moistureLab);
      res.moisture.source = 'lab';
    }
    if (isNaN(m)) { res.reason = 'MOISTURE_MISSING'; return res; }

    res.moisture.value = m;
    if (!res.moisture.source) {
      res.moisture.source = (trip.moistureSource === 'check') ? 'check' : 'lab';
    }
    var cls = moistureClass(m, cfg);
    res.moisture.cls = cls;

    if (cls === 'reject') {
      // 规则2：超标按拒收，这一趟不进结算
      res.rejected = true;
      res.reason = 'MOISTURE_REJECT';
      return res;
    }

    var mRate = moistureRate(m, cfg);            // 水分档扣率
    var dg = densityGrade(trip.density, cfg);    // 容重等级扣率
    var iRate = impurityRate(trip.impurity, cfg);// 杂质含率扣率
    res.moisture.rate = mRate;
    res.density.label = dg.label;
    res.density.rate = dg.deduct;
    res.impurity.rate = iRate;

    // 规则3：三样一起定，乘法联动，动一样另外两样的扣量跟着重算
    var factor = (1 - mRate) * (1 - dg.deduct) * (1 - iRate);
    res.factor = factor;
    res.settledKg = roundWeightKg(res.net * factor);
    return res;
  }

  // 整车结算。draft: {trips:[...]}, prices: {YYYY-MM-DD: price(元/吨)}
  // 返回 {ready, rejected, rejectTripIndex, settleKg, amount, price, priceDate, tripResults, note}
  function settleDraft(draft, cfg, prices) {
    var out = { ready: false, rejected: false, rejectTripIndex: -1, settleKg: 0,
      amount: 0, price: null, priceDate: null, tripResults: [], note: null };
    if (!draft.trips || draft.trips.length === 0) { out.note = 'NO_TRIP'; return out; }

    for (var i = 0; i < draft.trips.length; i++) {
      var t = evaluateTrip(draft.trips[i], draft.trips[i].configSnapshot || cfg);
      out.tripResults.push(t);
      if (t.reason === 'MOISTURE_PENDING' || t.reason === 'MOISTURE_MISSING') { out.note = t.reason; return out; }
      if (t.rejected) { out.rejected = true; out.rejectTripIndex = i; }
    }

    // 规则5：只按当天挂牌价；跨零点未开的单子落到第二天的价
    var date = draft.settleDate || todayStr();
    var price = prices ? prices[date] : null;
    if (price == null) { out.note = 'NO_PRICE'; out.priceDate = date; return out; }
    out.priceDate = date;
    out.price = Number(price);

    // 规则2：任一趟超标，整车按拒收处理（出拒收单，金额 0）
    if (out.rejected) { out.ready = true; return out; }

    var total = 0;
    for (var j = 0; j < out.tripResults.length; j++) total += out.tripResults[j].settledKg;
    // 规则8：两趟净重各自按各自化验单折干后加在一处
    out.settleKg = roundWeightKg(total);
    out.amount = roundAmount(total / 1000 * out.price);
    out.ready = true;
    return out;
  }

  // ---------- 单价换算 ----------
  function yuanPerJinToPerTon(p) { return Number(p) * 2000; }
  function yuanPerTonToPerJin(p) { return Number(p) / 2000; }
  function kgToJin(kg) { return kg * 2; }
  function jinToKg(jin) { return jin / 2; }

  function todayStr(d) {
    d = d || new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  return {
    defaultConfig: defaultConfig,
    round: round, roundWeightKg: roundWeightKg, roundAmount: roundAmount,
    moistureClass: moistureClass, moistureRate: moistureRate,
    densityGrade: densityGrade, impurityRate: impurityRate,
    wetToDryBasis: wetToDryBasis, dryToWetBasis: dryToWetBasis,
    evaluateTrip: evaluateTrip, settleDraft: settleDraft,
    yuanPerJinToPerTon: yuanPerJinToPerTon, yuanPerTonToPerJin: yuanPerTonToPerJin,
    kgToJin: kgToJin, jinToKg: jinToKg, todayStr: todayStr
  };
});
