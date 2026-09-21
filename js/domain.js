/*
 * 潮粮折干结算器 —— 核心结算逻辑（纯函数，无 DOM 依赖，浏览器/Node 通用）
 *
 * 扣量模型（可在设置里改）：
 *   水分：化验单水分 <= 安全水分        不扣
 *         安全水分 < 水分 <= 拒收水分    超安全部分每满一个步长扣一档，档扣率 × 扣量系数
 *         水分 > 拒收水分              该车拒收，不进结算
 *   杂质：杂质率 > 安全杂质后，同样按步长 × 档扣率 × 扣量系数扣
 *   容重：按容重值落等，等级自带扣率（一等 0%，等外也可拒收）
 *   三样扣率按顺序连乘落到净重上（水分扣完再扣杂质、再扣容重），
 *   所以动其中一样，另外两样扣到的重量也跟着变 —— 需求第 3 条。
 */
'use strict';

const ROUND_GRAIN_KG = 0.5; // 重量保留到 0.5 公斤（一市斤）
const MONEY_DECIMALS = 2;

function defaultParams() {
  return {
    grainName: '玉米',
    safeMoisture: 14.0,      // 安全水分（%），以内按原重
    rejectMoisture: 30.0,    // 超标拒收线（%），超过拒收
    moistureStep: 0.5,       // 水分每超过 0.5 个点为一档
    moistureDeduction: 1.0,  // 每档基础扣率（%）
    moistureTolerance: 0.05, // 化验/磅房水分一致判定容差（个百分点）
    safeImpurity: 1.0,       // 安全杂质（%）
    impurityStep: 0.5,       // 杂质每超 0.5 个点为一档
    impurityDeduction: 1.0,  // 杂质每档基础扣率（%）
    bulkGrades: [
      { name: '一等', minBulk: 720, deduction: 0.0 },
      { name: '二等', minBulk: 685, deduction: 1.0 },
      { name: '三等', minBulk: 650, deduction: 2.0 },
      { name: '等外', minBulk: 0,   deduction: 4.0, rejects: false },
    ],
  };
}

/* ---------------- 通用工具 ---------------- */

function roundHalfUp(value, step) {
  return Math.round(value / step) * step;
}

function roundWeight(kg) {
  return roundHalfUp(kg, ROUND_GRAIN_KG);
}

function roundMoney(yuan) {
  return Math.round((yuan + Number.EPSILON) * 100) / 100;
}

function sameMoisture(lab, recheck, tolerance) {
  if (lab == null || recheck == null) return false;
  return Math.abs(lab - recheck) <= tolerance;
}

// 化验/磅房水分是否已可用于结算：有值且（没复检 / 两边一致 / 人工点定了用哪个）
function moistureStatus(trip, params) {
  const lab = toNum(trip.labMoisture);
  const recheck = toNum(trip.recheckMoisture);
  if (lab == null) return { ready: false, reason: '缺化验单水分' };
  if (recheck == null) {
    return { ready: true, moisture: lab, source: '化验室', labSheetNo: trip.labSheetNo || '' };
  }
  if (sameMoisture(lab, recheck, params.moistureTolerance)) {
    return { ready: true, moisture: lab, source: '化验室/磅房一致', labSheetNo: trip.labSheetNo || '' };
  }
  // 需求第 4 条：对不上时两个数并排写着等人点，系统不自己挑
  if (trip.moistureChoice === 'lab') {
    return { ready: true, moisture: lab, source: '化验室(人工点定)', labSheetNo: trip.labSheetNo || '' };
  }
  if (trip.moistureChoice === 'recheck') {
    return {
      ready: true,
      moisture: recheck,
      source: '磅房复检(人工点定)',
      labSheetNo: trip.recheckSheetNo || trip.labSheetNo || '',
    };
  }
  return { ready: false, reason: '化验室与磅房水分不一致，等待点定', conflict: true };
}

function toNum(v) {
  if (v === '' || v === null || v === undefined || Number.isNaN(Number(v))) return null;
  return Number(v);
}

/* ---------------- 扣量计算 ---------------- */

// 超出安全线的部分按步长向上取整，算档扣率（%）；扣量系数=1 时等价于 1 档 1%
function stepDeductionPct(value, safe, step, perStepPct, coefficient) {
  if (value <= safe) return 0;
  const steps = Math.ceil((value - safe - 1e-9) / step);
  return steps * perStepPct * coefficient;
}

function moistureBand(moisture, params) {
  if (moisture <= params.safeMoisture) return 'safe';
  if (moisture > params.rejectMoisture) return 'reject';
  return 'middle';
}

function bulkGradeFor(bulkValue, gradeName, params) {
  if (gradeName != null && gradeName !== '') {
    const g = params.bulkGrades.find((x) => x.name === gradeName);
    if (g) return g;
  }
  if (bulkValue == null) return null;
  let found = null;
  for (const g of params.bulkGrades) {
    if (bulkValue >= g.minBulk && (!found || g.minBulk > found.minBulk)) found = g;
  }
  return found;
}

/**
 * 计算一趟过磅。
 * trip: { grossKg, tareKg, labMoisture, recheckMoisture, moistureChoice,
 *         labSheetNo, recheckSheetNo, impurityPct, bulkValue, bulkGradeId,
 *         weighedAt, moistureCoeffOverride? }
 * versionsAt: { moisture: [{effectiveAt, coefficient}], impurity: [{effectiveAt, coefficient}] }
 */
function calcTrip(trip, params, versionsAt) {
  const gross = toNum(trip.grossKg);
  const tare = toNum(trip.tareKg);
  const result = {
    tripId: trip.id,
    seq: trip.seq ?? null,
    weighedAt: trip.weighedAt,
    labSheetNo: trip.labSheetNo || '',
    grossKg: gross,
    tareKg: tare,
    netKg: gross != null && tare != null ? roundWeight(gross - tare) : null,
    errors: [],
  };

  if (result.netKg == null || result.netKg <= 0) {
    result.errors.push('净重无效');
    return result;
  }

  const ms = moistureStatus(trip, params);
  result.moistureStatus = ms;
  if (!ms.ready) {
    result.errors.push(ms.reason || '水分未定');
    return result;
  }

  const moisture = ms.moisture;
  result.moisture = moisture;
  result.moistureSource = ms.source;
  result.labSheetUsed = ms.labSheetNo;
  result.band = moistureBand(moisture, params);
  if (result.band === 'reject') {
    result.rejected = true;
    result.rejectReason = `水分 ${moisture}% 超过拒收线 ${params.rejectMoisture}%`;
    result.settledKg = 0;
    return result;
  }

  const moistureCoeff = trip.moistureCoeffOverride != null
    ? toNum(trip.moistureCoeffOverride)
    : coefficientAt(versionsAt?.moisture || [], trip.weighedAt);
  const impurityCoeff = coefficientAt(versionsAt?.impurity || [], trip.weighedAt);
  result.moistureCoefficient = moistureCoeff;
  result.impurityCoefficient = impurityCoeff;

  const moisturePct = result.band === 'safe'
    ? 0
    : stepDeductionPct(moisture, params.safeMoisture, params.moistureStep,
      params.moistureDeduction, moistureCoeff);

  const impurity = toNum(trip.impurityPct);
  if (impurity == null) result.errors.push('缺杂质含率');
  const impurityPct = impurity == null
    ? null
    : stepDeductionPct(impurity, params.safeImpurity, params.impurityStep,
      params.impurityDeduction, impurityCoeff);

  const grade = bulkGradeFor(toNum(trip.bulkValue), trip.bulkGradeName ?? null, params);
  if (!grade) result.errors.push('缺容重等级');
  if (grade && grade.rejects) {
    result.rejected = true;
    result.rejectReason = `容重等级「${grade.name}」按拒收处理`;
    result.settledKg = 0;
    return result;
  }

  if (result.errors.length) return result;

  result.impurityPct = impurity;
  result.grade = grade.name;
  result.bulkValue = toNum(trip.bulkValue);

  // 三样扣率连乘：动一样，另一样的扣量基数就变 —— 需求第 3 条
  const afterMoisture = result.netKg * (1 - moisturePct / 100);
  const afterImpurity = afterMoisture * (1 - impurityPct / 100);
  const settledRaw = afterImpurity * (1 - grade.deduction / 100);

  result.moistureDeductPct = round2(moisturePct);
  result.impurityDeductPct = round2(impurityPct);
  result.gradeDeductPct = round2(grade.deduction);
  result.weightAfterMoistureKg = roundWeight(afterMoisture);
  result.weightAfterImpurityKg = roundWeight(afterImpurity);
  result.settledKg = roundWeight(settledRaw);
  return result;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function coefficientAt(versions, at) {
  if (!versions || !versions.length) return 1;
  const t = new Date(at).getTime();
  let current = versions[0].coefficient;
  for (const v of versions) {
    if (new Date(v.effectiveAt).getTime() <= t) current = v.coefficient;
    else break;
  }
  return current;
}

/* ---------------- 整车（多趟）与价格 ---------------- */

function calcLoad(load, params, versionsAt, pricePerTonAtDate) {
  const trips = (load.trips || []).map((t) => calcTrip(t, params, versionsAt));
  const accepted = trips.filter((t) => !t.rejected && !t.errors.length && t.settledKg > 0);
  const rejected = trips.filter((t) => t.rejected);
  const pending = trips.filter((t) => !t.rejected && t.errors.length > 0);

  const totalNetKg = sum(trips.map((t) => t.netKg || 0));
  const settledKg = roundWeight(sum(accepted.map((t) => t.settledKg)));

  const ready = trips.length > 0 && pending.length === 0;
  const priceDate = load.priceDate || dateStr(load.previewAt || new Date());
  const pricePerTon = pricePerTonAtDate ? pricePerTonAtDate(priceDate) : null;

  const dryValue = pricePerTon == null
    ? null
    : roundMoney((settledKg / 1000) * pricePerTon);

  return {
    trips,
    accepted,
    rejected,
    pending,
    ready,
    totalNetKg: roundWeight(totalNetKg),
    settledKg,
    priceDate,
    pricePerTon,
    dryValue,
    basis: load.basis || 'dry', // 司机报价口径：dry=干基，wet=湿基
  };
}

// 湿基报价：同样的金额，除全部净重
function quoteForBasis(calc) {
  if (calc.dryValue == null) return null;
  if (calc.basis === 'wet') {
    const wetPerTon = calc.totalNetKg > 0
      ? round2((calc.dryValue / calc.totalNetKg) * 1000)
      : null;
    return {
      basis: 'wet',
      weightKg: roundWeight(calc.totalNetKg),
      unitPricePerTon: wetPerTon,
      amount: calc.dryValue,
    };
  }
  return {
    basis: 'dry',
    weightKg: calc.settledKg,
    unitPricePerTon: calc.pricePerTon,
    amount: calc.dryValue,
  };
}

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

function dateStr(d) {
  const x = new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function nextDateStr(d) {
  const x = new Date(d);
  x.setDate(x.getDate() + 1);
  return dateStr(x);
}

/* ---------------- 单价单位换算（每吨 / 每斤） ---------------- */

const TON_TO_JIN = 2000; // 1 吨 = 2000 斤
function perTonToPerJin(p) { return p == null ? null : round2(p / TON_TO_JIN); }
function perJinToPerTon(p) { return p == null ? null : round2(p * TON_TO_JIN); }

const KG_PER_JIN = 0.5;
function kgToJin(kg) { return kg == null ? null : round2(kg / KG_PER_JIN); }
function kgToTon(kg) { return kg == null ? null : round3(kg / 1000); }
function round3(n) {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

function formatMoney(n) {
  if (n == null) return '—';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const api = {
  ROUND_GRAIN_KG,
  defaultParams,
  roundWeight,
  roundMoney,
  sameMoisture,
  moistureStatus,
  moistureBand,
  bulkGradeFor,
  stepDeductionPct,
  calcTrip,
  calcLoad,
  quoteForBasis,
  coefficientAt,
  dateStr,
  nextDateStr,
  perTonToPerJin,
  perJinToPerTon,
  kgToJin,
  kgToTon,
  formatMoney,
  toNum,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.DRY = api;
}
