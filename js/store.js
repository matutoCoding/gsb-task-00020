/*
 * 状态存储：单据、价格、扣量系数版本、跨零点处理。
 * 规则落点：
 *   第5条  价格只算当天；未开单的车跨零点后按次日价重算（priceDate 滚动）
 *   第7条  单价单位（每吨/每斤）是全局显示开关，已开单快照不动
 *   第9条  扣量系数按生效时间版本化，每趟按过磅时刻取当时系数
 *   第10条 已开单不可改；重算另开新单并写明原单号
 *   第11条 重开单只能从第一趟重新走
 */
'use strict';

const DRY = (typeof window !== 'undefined') ? window.DRY : globalThis.DRY;

const STORAGE_KEY = 'chaoliang-settlement-v1';

function uid(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function createInitialState() {
  return {
    params: DRY.defaultParams(),
    // 挂牌价：{ date: 'YYYY-MM-DD', pricePerTon: number }，内部一律每吨
    prices: [],
    // 系数版本：effectiveAt ISO 字符串，按时间升序
    coeffVersions: {
      moisture: [{ id: uid('v_'), effectiveAt: '2000-01-01T00:00:00+08:00', coefficient: 1.0, note: '初始系数' }],
      impurity: [{ id: uid('v_'), effectiveAt: '2000-01-01T00:00:00+08:00', coefficient: 1.0, note: '初始系数' }],
    },
    loads: [],
    bills: [],
    seq: { bill: 1 },
    unit: 'ton', // ton=每吨, jin=每斤；只影响界面与未开单，已开单不动
  };
}

function save(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('保存失败', e);
  }
}

function loadState() {
  let state = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state = JSON.parse(raw);
  } catch (e) {
    console.error('读取失败', e);
  }
  if (!state) return null;
  if (!state.coeffVersions) state.coeffVersions = createInitialState().coeffVersions;
  return state;
}

/* ---------------- 车辆 / 趟次 ---------------- */

function addLoad(state, data) {
  const load = {
    id: uid('L'),
    plateNo: data.plateNo || '',
    driver: data.driver || '',
    grainName: data.grainName || state.params.grainName,
    createdAt: new Date().toISOString(),
    priceDate: null, // null = 跟随当前日期滚动（未开单的车）
    trips: [],
    status: 'draft', // draft | billed | reopened
    basis: 'dry',    // 给司机的报价口径
  };
  state.loads.unshift(load);
  return load;
}

function addTrip(state, loadId, data) {
  const load = state.loads.find((l) => l.id === loadId);
  if (!load) throw new Error('找不到该车');
  if (load.status === 'billed') throw new Error('该车已开单，不能再补趟次');
  const trip = {
    id: uid('T'),
    seq: load.trips.length + 1,
    grossKg: data.grossKg ?? '',
    tareKg: data.tareKg ?? '',
    weighedAt: data.weighedAt || new Date().toISOString(),
    labSheetNo: data.labSheetNo || '',
    labMoisture: data.labMoisture ?? '',
    recheckSheetNo: data.recheckSheetNo || '',
    recheckMoisture: data.recheckMoisture ?? '',
    moistureChoice: '', // '' | 'lab' | 'recheck'，冲突时等人点
    impurityPct: data.impurityPct ?? '',
    bulkValue: data.bulkValue ?? '',
    bulkGradeName: data.bulkGradeName ?? null,
  };
  load.trips.push(trip);
  return trip;
}

function updateTrip(state, loadId, tripId, patch) {
  const trip = findTrip(state, loadId, tripId);
  Object.assign(trip, patch);
  return trip;
}

function findTrip(state, loadId, tripId) {
  const load = state.loads.find((l) => l.id === loadId);
  const trip = load && load.trips.find((t) => t.id === tripId);
  if (!trip) throw new Error('找不到该趟');
  return trip;
}

function removeTrip(state, loadId, tripId) {
  const load = state.loads.find((l) => l.id === loadId);
  if (!load) throw new Error('找不到该车');
  if (load.status === 'billed') throw new Error('已开单的车不能改');
  load.trips = load.trips.filter((t) => t.id !== tripId);
  load.trips.forEach((t, i) => { t.seq = i + 1; });
}

function removeLoad(state, loadId) {
  const load = state.loads.find((l) => l.id === loadId);
  if (!load) return;
  if (load.status === 'billed') throw new Error('已开单的车不能删');
  state.loads = state.loads.filter((l) => l.id !== loadId);
}

/* ---------------- 计算辅助 ---------------- */

function priceLookup(state) {
  return (date) => {
    const row = state.prices.find((p) => p.date === date);
    return row ? row.pricePerTon : null;
  };
}

function calcLoadById(state, loadId, now = new Date()) {
  const load = state.loads.find((l) => l.id === loadId);
  if (!load) throw new Error('找不到该车');
  const previewLoad = { ...load, previewAt: now.toISOString() };
  return DRY.calcLoad(previewLoad, state.params, state.coeffVersions, priceLookup(state));
}

/* ---------------- 跨零点（第 5 条） ---------------- */

// 未开单的车价格日期始终跟着当前日走；返回是否发生了跨天
function rollover(state, now = new Date()) {
  const today = DRY.dateStr(now);
  let changed = false;
  for (const load of state.loads) {
    if (load.status === 'draft' && load.priceDate !== today) {
      load.priceDate = today;
      changed = true;
    }
  }
  return changed;
}

/* ---------------- 开单（第 10 条：一旦开出不可改） ---------------- */

function issueBill(state, loadId, now = new Date()) {
  const load = state.loads.find((l) => l.id === loadId);
  if (!load) throw new Error('找不到该车');
  if (load.status === 'billed') throw new Error('该车已开过单');

  load.priceDate = DRY.dateStr(now); // 锁定当天挂牌价
  const calc = DRY.calcLoad({ ...load }, state.params, state.coeffVersions, priceLookup(state));
  if (!calc.ready) throw new Error('还有趟次水分未点定或信息不全，不能开单');
  if (calc.pricePerTon == null) throw new Error(`${calc.priceDate} 没有挂牌价，不能开单`);

  const quote = DRY.quoteForBasis(calc);
  const bill = {
    id: uid('B'),
    billNo: String(state.seq.bill++).padStart(4, '0'),
    issuedAt: now.toISOString(),
    priceDate: calc.priceDate,
    plateNo: load.plateNo,
    driver: load.driver,
    grainName: load.grainName,
    basis: load.basis,
    unit: state.unit, // 快照：开单时用每吨还是每斤显示，旧单不随后续切换变
    loadId: load.id,
    trips: calc.trips.map(snapshotTrip),
    totalNetKg: calc.totalNetKg,
    settledKg: calc.settledKg,
    pricePerTon: calc.pricePerTon,
    amount: calc.dryValue,
    quoteWeightKg: quote.weightKg,
    quoteUnitPricePerTon: quote.unitPricePerTon,
    status: 'issued', // issued | superseded
    supersededBy: null,
    reissueOf: null,
  };
  state.bills.unshift(bill);
  load.status = 'billed';
  load.billId = bill.id;
  return bill;
}

function snapshotTrip(t) {
  return {
    tripSeq: t.seq,
    weighedAt: t.weighedAt,
    labSheetNo: t.labSheetUsed,
    moistureSource: t.moistureSource,
    moisture: t.moisture,
    band: t.band,
    netKg: t.netKg,
    impurityPct: t.impurityPct,
    bulkValue: t.bulkValue,
    grade: t.grade,
    moistureCoefficient: t.moistureCoefficient,
    impurityCoefficient: t.impurityCoefficient,
    moistureDeductPct: t.moistureDeductPct,
    impurityDeductPct: t.impurityDeductPct,
    gradeDeductPct: t.gradeDeductPct,
    weightAfterMoistureKg: t.weightAfterMoistureKg,
    weightAfterImpurityKg: t.weightAfterImpurityKg,
    grossKg: t.grossKg,
    tareKg: t.tareKg,
    settledKg: t.settledKg,
    rejected: !!t.rejected,
    rejectReason: t.rejectReason || '',
  };
}

/* ---------------- 重开单（第 10、11 条） ---------------- */

// 只能从该车第一趟重新走：用原单第一趟为起点逐趟核对，不能只挑后面某趟
function reissueFromFirstTrip(state, billId, editedTrips, now = new Date()) {
  const oldBill = state.bills.find((b) => b.id === billId);
  if (!oldBill) throw new Error('找不到原单');
  const load = state.loads.find((l) => l.id === oldBill.loadId);
  if (!load) throw new Error('找不到原车');

  if (!editedTrips || editedTrips.length !== load.trips.length) {
    throw new Error('重算必须从第一趟起，逐趟重新走完该车全部趟次');
  }

  // 把人在向导里改过的数值写回，趟次 id/seq/顺序不动，第一趟必须仍是第一趟
  load.trips.forEach((trip, i) => {
    const edited = editedTrips[i];
    const fields = ['grossKg', 'tareKg', 'labSheetNo', 'labMoisture', 'recheckSheetNo',
      'recheckMoisture', 'moistureChoice', 'impurityPct', 'bulkValue', 'bulkGradeName', 'weighedAt'];
    for (const f of fields) if (edited[f] !== undefined) trip[f] = edited[f];
  });

  load.priceDate = DRY.dateStr(now);
  const calc = DRY.calcLoad({ ...load }, state.params, state.coeffVersions, priceLookup(state));
  if (!calc.ready) throw new Error('还有趟次水分未点定或信息不全，不能开单');
  if (calc.pricePerTon == null) throw new Error(`${calc.priceDate} 没有挂牌价，不能开单`);

  const quote = DRY.quoteForBasis(calc);
  const bill = {
    id: uid('B'),
    billNo: String(state.seq.bill++).padStart(4, '0'),
    issuedAt: now.toISOString(),
    priceDate: calc.priceDate,
    plateNo: load.plateNo,
    driver: load.driver,
    grainName: load.grainName,
    basis: load.basis,
    unit: state.unit,
    loadId: load.id,
    trips: calc.trips.map(snapshotTrip),
    totalNetKg: calc.totalNetKg,
    settledKg: calc.settledKg,
    pricePerTon: calc.pricePerTon,
    amount: calc.dryValue,
    quoteWeightKg: quote.weightKg,
    quoteUnitPricePerTon: quote.unitPricePerTon,
    status: 'issued',
    supersededBy: null,
    reissueOf: oldBill.billNo,
  };

  oldBill.status = 'superseded';
  oldBill.supersededBy = bill.billNo;
  state.bills.unshift(bill);
  load.status = 'billed';
  load.billId = bill.id;
  return bill;
}

/* ---------------- 挂牌价 / 系数版本 ---------------- */

function setPrice(state, date, pricePerTon) {
  const row = state.prices.find((p) => p.date === date);
  if (row) row.pricePerTon = pricePerTon;
  else state.prices.push({ date, pricePerTon });
  state.prices.sort((a, b) => a.date.localeCompare(b.date));
}

function addCoeffVersion(state, kind, coefficient, effectiveAt, note) {
  const list = state.coeffVersions[kind];
  const entry = { id: uid('v_'), coefficient, effectiveAt, note: note || '' };
  list.push(entry);
  list.sort((a, b) => new Date(a.effectiveAt) - new Date(b.effectiveAt));
  return entry;
}

function updateParams(state, patch) {
  Object.assign(state.params, patch);
}

const Store = {
  STORAGE_KEY,
  createInitialState,
  save,
  loadState,
  uid,
  addLoad,
  addTrip,
  updateTrip,
  removeTrip,
  removeLoad,
  calcLoadById,
  rollover,
  issueBill,
  reissueFromFirstTrip,
  setPrice,
  addCoeffVersion,
  updateParams,
  priceLookup,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Store;
}
if (typeof window !== 'undefined') {
  window.Store = Store;
}
