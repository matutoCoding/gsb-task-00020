/* 本地持久化：localStorage。已开单据只追加、不改写（规则10） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.Store = factory(root.GS);
})(typeof self !== 'undefined' ? self : this, function (GS) {
  'use strict';
  var KEY = 'chaoliang-zhegan-v1';

  function freshState() {
    return {
      config: GS.defaultConfig(),
      prices: {},                 // {YYYY-MM-DD: 元/吨}
      drafts: [],                 // 未开单的在算车辆
      bills: [],                  // 已开单据（只追加）
      seq: {},                    // {YYYYMMDD: 当日序号}
      prefs: { unit: 'ton', basis: 'wet' }
    };
  }

  var state = load();
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) return Object.assign(freshState(), JSON.parse(raw));
    } catch (e) { /* 忽略损坏数据 */ }
    return freshState();
  }
  function save() { localStorage.setItem(KEY, JSON.stringify(state)); }
  function get() { return state; }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function snapshotConfig() { return clone(state.config); }

  function nextBillNo(dateStr) {
    var compact = dateStr.replace(/-/g, '');
    state.seq[compact] = (state.seq[compact] || 0) + 1;
    return 'JS-' + compact + '-' + String(state.seq[compact]).padStart(3, '0');
  }

  // ---------- 配置 ----------
  function updateConfig(patch) {
    Object.assign(state.config, patch);
    save();
  }

  // ---------- 挂牌价 ----------
  function setPrice(dateStr, pricePerTon) {
    state.prices[dateStr] = GS.round(Number(pricePerTon), 3);
    save();
  }
  function priceOn(dateStr) { return state.prices[dateStr]; }

  // ---------- 在算车辆 ----------
  function createDraft(plate, driver, recalcOf) {
    var now = new Date();
    var d = {
      id: 'D' + now.getTime() + Math.floor(Math.random() * 1000),
      plate: plate || '',
      driver: driver || '',
      createdAt: now.toISOString(),
      businessDate: GS.todayStr(now), // 建车当日，跨零点重算用
      trips: [],
      recalcOf: recalcOf || null      // 规则10/11：另开新单时记原单号
    };
    state.drafts.push(d);
    save();
    return d;
  }
  function getDraft(id) { return state.drafts.find(function (d) { return d.id === id; }); }
  function updateDraft(id, patch) {
    var d = getDraft(id);
    if (d) { Object.assign(d, patch); save(); }
    return d;
  }
  function removeDraft(id) {
    state.drafts = state.drafts.filter(function (d) { return d.id !== id; });
    save();
  }

  // 规则11：重算只能从第一趟重新走 —— 复制原单的车与司机，不留旧趟次
  function createRecalcDraft(bill) {
    return createDraft(bill.plate, bill.driver, bill.billNo);
  }

  // 保存一趟；过磅时点冻结扣量系数快照（规则9）
  function upsertTrip(draftId, trip) {
    var d = getDraft(draftId);
    if (!d) return null;
    var t = {
      key: trip.key || ('T' + Date.now() + Math.floor(Math.random() * 1000)),
      gross: num(trip.gross), tare: num(trip.tare),
      moistureLab: numOrNull(trip.moistureLab),
      moistureCheck: numOrNull(trip.moistureCheck),
      moistureSource: trip.moistureSource || null,   // lab | check | null(待定)
      density: numOrNull(trip.density),
      impurity: numOrNull(trip.impurity),
      labNo: trip.labNo || '',
      weighedAt: new Date().toISOString(),
      configSnapshot: snapshotConfig()
    };
    var i = indexTrip(d, t.key);
    if (i >= 0) d.trips[i] = t; else d.trips.push(t);
    save();
    return t;
  }
  function removeTrip(draftId, key) {
    var d = getDraft(draftId);
    if (!d) return;
    d.trips = d.trips.filter(function (t) { return t.key !== key; });
    save();
  }
  function indexTrip(d, key) {
    for (var i = 0; i < d.trips.length; i++) if (d.trips[i].key === key) return i;
    return -1;
  }
  function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
  function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return isNaN(n) ? null : n;
  }

  // ---------- 开具单据（只追加，不可改） ----------
  function issueBill(draftId, settle) {
    var d = getDraft(draftId);
    if (!d || !settle.ready) return null;
    var date = settle.priceDate;
    var bill = {
      billNo: nextBillNo(date),
      issuedAt: new Date().toISOString(),
      priceDate: date,
      plate: d.plate, driver: d.driver,
      grain: state.config.grainName,
      rejected: !!settle.rejected,
      rejectTripIndex: settle.rejectTripIndex,
      trips: clone(d.trips),
      tripResults: clone(settle.tripResults),
      price: settle.price,
      settleKg: settle.settleKg,
      amount: settle.amount,
      basis: state.prefs.basis,      // 开单时司机采用的报法
      unit: state.prefs.unit,        // 开单时显示单位（规则7：旧单不动）
      recalcOf: d.recalcOf || null
    };
    state.bills.unshift(bill);
    state.drafts = state.drafts.filter(function (x) { return x.id !== draftId; });
    save();
    return bill;
  }

  function setPrefs(p) { Object.assign(state.prefs, p); save(); }

  function exportAll() { return JSON.stringify(state, null, 2); }
  function importAll(json) {
    var data = JSON.parse(json);
    state = Object.assign(freshState(), data);
    save();
  }
  function clearAll() { state = freshState(); save(); }

  return {
    get: get, save: save,
    updateConfig: updateConfig,
    setPrice: setPrice, priceOn: priceOn,
    createDraft: createDraft, getDraft: getDraft, updateDraft: updateDraft,
    removeDraft: removeDraft, createRecalcDraft: createRecalcDraft,
    upsertTrip: upsertTrip, removeTrip: removeTrip,
    issueBill: issueBill, nextBillNo: nextBillNo,
    setPrefs: setPrefs,
    exportAll: exportAll, importAll: importAll, clearAll: clearAll
  };
});
