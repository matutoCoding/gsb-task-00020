/* 界面层：录入、渲染、开单、打印、跨零点提示 */
'use strict';

let state = Store.loadState();
if (!state) {
  state = Store.createInitialState();
  seedDemo(state);
  Store.save(state);
}

let currentLoadId = null;
let lastPriceDate = DRY.dateStr(new Date());

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- 单位 / 金额显示（第7条：切单位所有行跟着换，已开单不动） ---------- */

function priceLabel(perTon) {
  if (perTon == null) return '—';
  return state.unit === 'jin'
    ? `${DRY.perTonToPerJin(perTon)} 元/斤`
    : `${perTon} 元/吨`;
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- 时钟与跨零点（第5条） ---------- */

function tick() {
  const now = new Date();
  $('clock').textContent = now.toLocaleString('zh-CN', { hour12: false });
  const today = DRY.dateStr(now);
  if (today !== lastPriceDate) {
    const changed = Store.rollover(state, now);
    if (changed) {
      const banner = $('rolloverBanner');
      banner.textContent = `已过零点（${today}），未开单的车辆已按今日牌价重新结算。`;
      banner.classList.remove('hidden');
      setTimeout(() => banner.classList.add('hidden'), 8000);
    }
    lastPriceDate = today;
    Store.save(state);
  }
  renderAll();
}

/* ---------- 总渲染 ---------- */

function renderAll() {
  renderTopPrice();
  renderLoads();
  renderDetail();
  renderBills();
  renderPrices();
  renderCoeffs();
  renderParams();
}

function renderTopPrice() {
  const today = DRY.dateStr(new Date());
  const p = Store.priceLookup(state)(today);
  $('todayPrice').textContent = p == null
    ? `${today} 未挂牌，请先录入`
    : `${priceLabel(p)}（${today}）`;
  $('unitSelect').value = state.unit;
}

/* ---------- 车辆列表 ---------- */

function renderLoads() {
  const ul = $('loadList');
  if (!state.loads.length) {
    ul.innerHTML = '<li class="empty-hint">还没有登记车辆</li>';
    return;
  }
  ul.innerHTML = state.loads.map((load) => {
    const calc = Store.calcLoadById(state, load.id, new Date());
    const tag = load.status === 'billed'
      ? '<span class="tag billed">已开单</span>'
      : calc.pending.length
        ? '<span class="tag warn">待点定水分</span>'
        : calc.rejected.length
          ? '<span class="tag rej">有拒收趟</span>'
          : '<span class="tag draft">未开单</span>';
    return `
      <li class="load-item ${load.id === currentLoadId ? 'selected' : ''}" data-id="${load.id}">
        <div class="plate">${esc(load.plateNo || '未填车号')} ${tag}</div>
        <div class="meta">${esc(load.driver || '')} · ${load.trips.length} 趟
        · 净重 ${calc.totalNetKg}kg · 干重 ${calc.settledKg}kg</div>
      </li>`;
  }).join('');
  ul.querySelectorAll('.load-item').forEach((li) => {
    li.addEventListener('click', () => {
      currentLoadId = li.dataset.id;
      renderAll();
    });
  });
}

/* ---------- 车辆详情 ---------- */

function renderDetail() {
  const box = $('loadDetail');
  const load = state.loads.find((l) => l.id === currentLoadId);
  if (!load) {
    box.className = 'empty-hint';
    box.textContent = '从左边选一辆车，或点「+ 新车」开始登记。';
    return;
  }
  box.className = 'detail-card';
  const calc = Store.calcLoadById(state, load.id, new Date());
  const billed = load.status === 'billed';
  const bill = billed ? state.bills.find((b) => b.id === load.billId) : null;

  box.innerHTML = `
    <div class="detail-head">
      <label class="field">车牌
        <input id="fPlate" value="${esc(load.plateNo)}" ${billed ? 'disabled' : ''} /></label>
      <label class="field">司机
        <input id="fDriver" value="${esc(load.driver)}" ${billed ? 'disabled' : ''} /></label>
      <label class="field">品种<input value="${esc(load.grainName)}" disabled /></label>
      <label class="field">给司机报价口径
        <select id="fBasis" ${billed ? 'disabled' : ''}>
          <option value="dry" ${load.basis === 'dry' ? 'selected' : ''}>干基（折干重量×挂牌价）</option>
          <option value="wet" ${load.basis === 'wet' ? 'selected' : ''}>湿基（折成湿粮单价报）</option>
        </select></label>
      <div class="detail-actions">
        ${billed
          ? `<button class="btn" id="viewBillBtn">查看单据 ${esc(bill.billNo)}</button>
             <button class="btn primary" id="reissueBtn">重开一张（从第1趟）</button>`
          : `<button class="btn danger" id="delLoadBtn">删车</button>
             <button class="btn primary" id="issueBtn" ${calc.ready && calc.pricePerTon != null ? '' : 'disabled'}>开单（锁今日牌价）</button>`}
      </div>
    </div>
    ${billed ? '<p class="hint" style="margin-top:8px">该车已开单，内容锁定不可修改；要改数请点「重开一张」，从第一趟重新走。</p>' : ''}
    <div class="trips">
      ${billed
        ? bill.trips.map((snap, i) => tripCardFromBill(snap, load.trips[i] || null)).join('')
        : calc.trips.map((t, i) => tripCardHtml(load, load.trips[i], t, false)).join('')}
    </div>
    ${billed ? '' : '<button class="btn" id="addTripBtn">+ 增加一趟过磅（一车多趟分开化验）</button>'}
    ${billed ? billSummaryHtml(bill) : summaryHtml(calc)}`;

  wireDetail(load, calc, bill);
}

function tripCardHtml(load, raw, t, billed) {
  const cls = t.rejected ? 'rejected' : t.errors.length ? 'pending' : '';
  const ms = t.moistureStatus || {};
  const gradeOpts = state.params.bulkGrades.map((g) =>
    `<option value="${esc(g.name)}" ${raw.bulkGradeName === g.name ? 'selected' : ''}>${g.name}</option>`).join('');
  return `
  <div class="trip-card ${cls}">
    <div class="trip-title">第 ${raw.seq} 趟
      ${t.rejected ? '<span class="tag rej">拒收</span>' : ''}
      ${!t.rejected && t.errors.length ? '<span class="tag warn">信息不全/待点定</span>' : ''}
      <span class="hint">过磅：${new Date(raw.weighedAt).toLocaleString('zh-CN', { hour12: false })}</span>
      <span style="margin-left:auto">
        ${billed ? '' : `<button class="btn small danger" data-del-trip="${raw.id}">删趟</button>`}
      </span>
    </div>
    <div class="trip-grid">
      <label class="field">毛重(kg)
        <input data-f="grossKg" data-trip="${raw.id}" type="number" step="0.5"
          value="${raw.grossKg}" ${billed ? 'disabled' : ''} /></label>
      <label class="field">皮重(kg)
        <input data-f="tareKg" data-trip="${raw.id}" type="number" step="0.5"
          value="${raw.tareKg}" ${billed ? 'disabled' : ''} /></label>
      <label class="field">净重(kg)<input value="${t.netKg ?? '—'}" disabled /></label>
      <label class="field">杂质含率(%)
        <input data-f="impurityPct" data-trip="${raw.id}" type="number" step="0.01"
          value="${raw.impurityPct}" ${billed ? 'disabled' : ''} /></label>

      <label class="field">化验室化验单号
        <input data-f="labSheetNo" data-trip="${raw.id}" value="${esc(raw.labSheetNo)}" ${billed ? 'disabled' : ''} /></label>
      <label class="field">化验室水分(%)
        <input data-f="labMoisture" data-trip="${raw.id}" type="number" step="0.01"
          value="${raw.labMoisture}" ${billed ? 'disabled' : ''} /></label>
      <label class="field">磅房复检单号
        <input data-f="recheckSheetNo" data-trip="${raw.id}" value="${esc(raw.recheckSheetNo)}" ${billed ? 'disabled' : ''} /></label>
      <label class="field">磅房复检水分(%)
        <input data-f="recheckMoisture" data-trip="${raw.id}" type="number" step="0.01"
          value="${raw.recheckMoisture}" ${billed ? 'disabled' : ''} /></label>

      <label class="field">容重(g/L)
        <input data-f="bulkValue" data-trip="${raw.id}" type="number" step="1"
          value="${raw.bulkValue}" ${billed ? 'disabled' : ''} /></label>
      <label class="field">容重等级
        <select data-f="bulkGradeName" data-trip="${raw.id}" ${billed ? 'disabled' : ''}>
          <option value="">按容重自动定等</option>${gradeOpts}
        </select></label>
      <label class="field">采用水分 / 化验单
        <input value="${ms.ready ? `${t.moisture}%（${esc(t.moistureSource)}）${esc(t.labSheetUsed || '')}` : '等待处理'}" disabled /></label>
      <label class="field">过磅时间
        <input data-f="weighedAtLocal" data-trip="${raw.id}" type="datetime-local"
          value="${toLocalInput(raw.weighedAt)}" ${billed ? 'disabled' : ''} /></label>
    </div>
    ${conflictHtml(raw, t, billed)}
    ${t.rejected ? `<div class="deduct-line">拒收原因：<b>${esc(t.rejectReason)}</b>，本趟不进入结算重量。</div>` : ''}
    ${t.settledKg > 0 ? deductHtml(t) : ''}
  </div>`;
}

/* 已开单车辆：按单据快照只读展示，规则随后怎么改都不影响这张单 */
function tripCardFromBill(s, liveTrip) {
  const raw = {
    id: '', seq: s.tripSeq, weighedAt: s.weighedAt,
    grossKg: s.grossKg ?? liveTrip?.grossKg ?? '',
    tareKg: s.tareKg ?? liveTrip?.tareKg ?? '',
    labSheetNo: s.labSheetNo || '', labMoisture: s.moisture ?? '',
    recheckSheetNo: '', recheckMoisture: '',
    impurityPct: s.impurityPct ?? liveTrip?.impurityPct ?? '',
    bulkValue: s.bulkValue ?? liveTrip?.bulkValue ?? '',
    bulkGradeName: s.grade || null,
  };
  const t = {
    netKg: s.netKg,
    moistureStatus: { ready: true },
    moisture: s.moisture, moistureSource: s.moistureSource, labSheetUsed: s.labSheetNo,
    band: s.band, rejected: s.rejected, rejectReason: s.rejectReason, settledKg: s.settledKg,
    errors: [],
    moistureDeductPct: s.moistureDeductPct, impurityDeductPct: s.impurityDeductPct,
    gradeDeductPct: s.gradeDeductPct, grade: s.grade,
    moistureCoefficient: s.moistureCoefficient, impurityCoefficient: s.impurityCoefficient,
    weightAfterMoistureKg: s.weightAfterMoistureKg, weightAfterImpurityKg: s.weightAfterImpurityKg,
  };
  // 快照没有复检数值与等级下拉，只读卡片里直接隐藏这两栏
  const html = tripCardHtml(raw, raw, t, true);
  return html
    .replace(/<label class="field">磅房复检单号[\s\S]*?<\/label>/, '<span></span>')
    .replace(/<label class="field">磅房复检水分\(%\)[\s\S]*?<\/label>/, '<span></span>');
}

function billSummaryHtml(b) {
  const unit = b.unit === 'jin' ? '元/斤' : '元/吨';
  const qPrice = b.unit === 'jin' ? DRY.perTonToPerJin(b.quoteUnitPricePerTon) : b.quoteUnitPricePerTon;
  const qWeight = b.unit === 'jin' ? DRY.kgToJin(b.quoteWeightKg) : b.quoteWeightKg;
  const wUnit = b.unit === 'jin' ? '斤' : 'kg';
  const rej = b.trips.filter((t) => t.rejected).length;
  return `
  <div class="summary">
    <div class="num-box"><div class="label">合计净重（湿）</div><div class="value">${b.totalNetKg} kg</div></div>
    <div class="num-box"><div class="label">结算折干重量</div><div class="value">${b.settledKg} kg</div></div>
    <div class="num-box"><div class="label">计价日 / 挂牌价</div>
      <div class="value" style="font-size:15px">${b.priceDate}<br>${b.pricePerTon} 元/吨</div></div>
    <div class="num-box"><div class="label">应付金额（元）</div><div class="value">${DRY.formatMoney(b.amount)}</div></div>
  </div>
  <div class="basis-line">本单按<b>${b.basis === 'dry' ? '干基' : '湿基'}</b>开给司机：
    报重 <b>${qWeight} ${wUnit}</b>，单价 <b>${qPrice} ${unit}</b>，金额 ${DRY.formatMoney(b.amount)} 元。
    ${rej ? `<span class="tag rej">${rej} 趟拒收</span>` : ''}
    <span class="hint">（数字取自单据快照，不随后续改价/改规则变动）</span>
  </div>`;
}

function conflictHtml(raw, t, billed) {
  const ms = t.moistureStatus;
  if (!ms || !ms.conflict || billed) return '';
  return `
  <div class="conflict-box">
    ⚠ 化验室水分 <b>${raw.labMoisture}%</b> 与磅房复检 <b>${raw.recheckMoisture}%</b> 对不上，
    请点定本趟按哪个数结算（系统不替您挑）：
    <div class="pick">
      <button class="pick-btn ${raw.moistureChoice === 'lab' ? 'chosen' : ''}"
        data-pick="lab" data-trip="${raw.id}">用化验室 ${raw.labMoisture}%（${esc(raw.labSheetNo)}）</button>
      <button class="pick-btn ${raw.moistureChoice === 'recheck' ? 'chosen' : ''}"
        data-pick="recheck" data-trip="${raw.id}">用磅房复检 ${raw.recheckMoisture}%（${esc(raw.recheckSheetNo)}）</button>
    </div>
  </div>`;
}

function deductHtml(t) {
  return `
  <div class="deduct-line">
    扣量连乘：净重 ${t.netKg}kg
    → 扣水分 <b>${t.moistureDeductPct}%</b>(系数×${t.moistureCoefficient}) 后 ${t.weightAfterMoistureKg}kg
    → 扣杂质 <b>${t.impurityDeductPct}%</b>(系数×${t.impurityCoefficient}) 后 ${t.weightAfterImpurityKg}kg
    → 容重【${esc(t.grade)}】扣 <b>${t.gradeDeductPct}%</b>
    = <b>${t.settledKg} kg</b>
  </div>`;
}

function summaryHtml(calc) {
  const q = DRY.quoteForBasis(calc);
  const wetUnit = state.unit === 'jin'
    ? `${DRY.perTonToPerJin(q.unitPricePerTon)} 元/斤`
    : `${q.unitPricePerTon} 元/吨`;
  const rejectedNote = calc.rejected.length
    ? `<span class="tag rej">${calc.rejected.length} 趟拒收，未计入</span>` : '';
  const priceWarn = calc.pricePerTon == null
    ? `<span class="tag warn">${calc.priceDate} 还没有挂牌价，先去「挂牌价与规则」录入</span>` : '';
  return `
  <div class="summary">
    <div class="num-box"><div class="label">合计净重（湿）</div><div class="value">${calc.totalNetKg} kg</div></div>
    <div class="num-box"><div class="label">结算折干重量</div><div class="value">${calc.settledKg} kg</div></div>
    <div class="num-box"><div class="label">计价日 / 挂牌价</div>
      <div class="value" style="font-size:15px">${calc.priceDate}<br>${priceLabel(calc.pricePerTon)}</div></div>
    <div class="num-box"><div class="label">应付金额（元）</div><div class="value">${DRY.formatMoney(calc.dryValue)}</div></div>
  </div>
  <div class="basis-line">给司机按<b>${q.basis === 'dry' ? '干基' : '湿基'}</b>报：
    报重 <b>${q.weightKg} kg</b>，单价 <b>${q.basis === 'dry' ? priceLabel(q.unitPricePerTon) : wetUnit}</b>，
    金额 ${DRY.formatMoney(q.amount)} 元（两种口径金额相同）。${rejectedNote}${priceWarn}
  </div>`;
}

/* ---------- 详情事件绑定 ---------- */

function wireDetail(load, calc, bill) {
  const billed = load.status === 'billed';

  if (!billed) {
    const plate = $('fPlate');
    const driver = $('fDriver');
    plate.addEventListener('change', () => { load.plateNo = plate.value; saveAndRender(load.id); });
    driver.addEventListener('change', () => { load.driver = driver.value; saveAndRender(load.id); });
    $('fBasis').addEventListener('change', (e) => { load.basis = e.target.value; saveAndRender(load.id); });
    $('addTripBtn').addEventListener('click', () => {
      Store.addTrip(state, load.id, {});
      saveAndRender(load.id);
    });
    $('delLoadBtn').addEventListener('click', () => {
      if (confirm('删除这辆未开单的车？')) {
        Store.removeLoad(state, load.id);
        currentLoadId = null;
        saveAndRender(null);
      }
    });
    $('issueBtn').addEventListener('click', () => {
      try {
        const b = Store.issueBill(state, load.id, new Date());
        saveAndRender(load.id);
        openBill(b.id);
      } catch (e) { alert(e.message); }
    });

    document.querySelectorAll('[data-f]').forEach((input) => {
      input.addEventListener('change', () => {
        const f = input.dataset.f;
        let value = input.value;
        if (f === 'weighedAtLocal') {
          Store.updateTrip(state, load.id, input.dataset.trip,
            { weighedAt: value ? new Date(value).toISOString() : new Date().toISOString() });
        } else if (f === 'bulkGradeName') {
          Store.updateTrip(state, load.id, input.dataset.trip, { bulkGradeName: value || null });
        } else {
          Store.updateTrip(state, load.id, input.dataset.trip, { [f]: value });
        }
        saveAndRender(load.id);
      });
    });
    document.querySelectorAll('[data-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        Store.updateTrip(state, load.id, btn.dataset.trip, { moistureChoice: btn.dataset.pick });
        saveAndRender(load.id);
      });
    });
    document.querySelectorAll('[data-del-trip]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (confirm('删除这一趟？')) {
          Store.removeTrip(state, load.id, btn.dataset.delTrip);
          saveAndRender(load.id);
        }
      });
    });
  } else {
    $('viewBillBtn').addEventListener('click', () => openBill(bill.id));
    $('reissueBtn').addEventListener('click', () => openReissueWizard(bill.id));
  }
}

function saveAndRender(selectId) {
  Store.save(state);
  currentLoadId = selectId;
  renderAll();
}

/* ---------- 新车 ---------- */

$('newLoadBtn').addEventListener('click', () => {
  const plateNo = prompt('车牌号：');
  if (plateNo == null) return;
  const load = Store.addLoad(state, { plateNo: plateNo.trim() });
  Store.addTrip(state, load.id, {});
  currentLoadId = load.id;
  saveAndRender(load.id);
});

/* ---------- 已开单据页 ---------- */

function renderBills() {
  const tbody = $('billRows');
  if (!state.bills.length) {
    tbody.innerHTML = '<tr><td colspan="13" class="empty-hint">还没有开出的单据</td></tr>';
    return;
  }
  tbody.innerHTML = state.bills.map((b) => {
    const basis = b.basis === 'dry' ? '干基' : '湿基';
    const unit = b.unit === 'jin' ? '元/斤' : '元/吨';
    const qPrice = b.unit === 'jin' ? DRY.perTonToPerJin(b.quoteUnitPricePerTon) : b.quoteUnitPricePerTon;
    const status = b.status === 'superseded'
      ? '<span class="tag rej">已被新单取代</span>'
      : '<span class="tag billed">有效</span>';
    return `
    <tr class="${b.status === 'superseded' ? 'superseded' : ''}">
      <td>${esc(b.billNo)}</td>
      <td><span class="no-strike">${status}</span></td>
      <td>${esc(b.plateNo)}</td>
      <td>${esc(b.driver)}</td>
      <td>${new Date(b.issuedAt).toLocaleString('zh-CN', { hour12: false })}</td>
      <td>${b.priceDate}</td>
      <td>${basis}</td>
      <td class="num">${b.totalNetKg}</td>
      <td class="num">${b.settledKg}</td>
      <td class="num">${qPrice ?? '—'} ${unit}</td>
      <td class="num">${DRY.formatMoney(b.amount)}</td>
      <td class="no-strike">${b.reissueOf ? `原单 ${esc(b.reissueOf)}` : '—'}</td>
      <td class="no-strike"><button class="btn small" data-bill="${b.id}">查看/打印</button></td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('[data-bill]').forEach((btn) => {
    btn.addEventListener('click', () => openBill(btn.dataset.bill));
  });
}

/* ---------- 单据打印（第6条：标注化验单；第10条：写明原单号） ---------- */

function openBill(billId) {
  const b = state.bills.find((x) => x.id === billId);
  if (!b) return;
  const unit = b.unit === 'jin' ? '元/斤' : '元/吨';
  const qPrice = b.unit === 'jin' ? DRY.perTonToPerJin(b.quoteUnitPricePerTon) : b.quoteUnitPricePerTon;
  const qWeight = b.unit === 'jin' ? DRY.kgToJin(b.quoteWeightKg) : b.quoteWeightKg;
  const wUnit = b.unit === 'jin' ? '斤' : 'kg';
  $('billPrintArea').innerHTML = `
    <div class="bill-title">${esc(b.grainName)}潮粮折干结算单</div>
    <div class="bill-sub">单号 ${b.billNo} · 开单 ${new Date(b.issuedAt).toLocaleString('zh-CN', { hour12: false })}</div>
    ${b.reissueOf ? `<div class="reissue-note">本单为重新结算单，原单号：<b>${esc(b.reissueOf)}</b>，原单已作废。</div>` : ''}
    <div class="bill-info">
      <div>车牌：<b>${esc(b.plateNo)}</b></div>
      <div>司机：<b>${esc(b.driver)}</b></div>
      <div>计价日：<b>${b.priceDate}</b></div>
      <div>报价口径：<b>${b.basis === 'dry' ? '干基' : '湿基（按全部净重折算湿粮单价）'}</b></div>
      <div>挂牌价：<b>${b.pricePerTon} 元/吨</b></div>
      <div>合计净重：<b>${b.totalNetKg} kg</b></div>
    </div>
    <table class="grid">
      <thead><tr>
        <th>趟</th><th>化验单(采用)</th><th>水分来源</th><th class="num">水分%</th>
        <th class="num">毛</th><th class="num">皮</th><th class="num">净重kg</th>
        <th class="num">水扣%</th><th class="num">杂扣%</th><th class="num">等扣%</th>
        <th>等级</th><th class="num">结算kg</th><th>备注</th>
      </tr></thead>
      <tbody>
        ${b.trips.map((t) => `
          <tr${t.rejected ? ' style="background:#fffbeb"' : ''}>
            <td>${t.tripSeq}</td>
            <td>${esc(t.labSheetNo || '—')}</td>
            <td>${esc(t.moistureSource)}</td>
            <td class="num">${t.moisture ?? '—'}${t.band ? `（${{ safe: '安全', middle: '折量', reject: '拒收' }[t.band]}）` : ''}</td>
            <td class="num">${t.grossKg ?? ''}</td>
            <td class="num">${t.tareKg ?? ''}</td>
            <td class="num">${t.netKg ?? ''}</td>
            <td class="num">${t.moistureDeductPct ?? ''}</td>
            <td class="num">${t.impurityDeductPct ?? ''}</td>
            <td class="num">${t.gradeDeductPct ?? ''}</td>
            <td>${esc(t.grade || '—')}</td>
            <td class="num">${t.settledKg}</td>
            <td>${t.rejected ? esc(t.rejectReason) : ''}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    <div class="bill-total">
      结算折干重量 ${b.settledKg} kg · 按${b.basis === 'dry' ? '干基' : '湿基'}报
      ${qWeight} ${wUnit} × ${qPrice} ${unit}
      = 应付 <span style="font-size:24px">${DRY.formatMoney(b.amount)}</span> 元
    </div>
    <p class="hint">磅房：________ 化验：________ 司机签字：________</p>`;
  $('billModal').classList.remove('hidden');
}

$('closeBillBtn').addEventListener('click', () => $('billModal').classList.add('hidden'));
$('printBillBtn').addEventListener('click', () => window.print());

/* ---------- 重开单向导（第10、11条） ---------- */

function openReissueWizard(billId) {
  const oldBill = state.bills.find((b) => b.id === billId);
  const load = state.loads.find((l) => l.id === oldBill.loadId);
  if (!confirm(`将按原单 ${oldBill.billNo} 重新结算：必须从第一趟起，逐趟核对 ${load.trips.length} 趟。继续？`)) return;

  const edited = load.trips.map((t) => ({
    grossKgStr: prompt(`第 ${t.seq} 趟 毛重(kg)（原 ${t.grossKg}）`, String(t.grossKg)),
    tareKgStr: prompt(`第 ${t.seq} 趟 皮重(kg)（原 ${t.tareKg}）`, String(t.tareKg)),
    labMoistureStr: prompt(`第 ${t.seq} 趟 化验室水分%（原 ${t.labMoisture}，化验单 ${t.labSheetNo}）`, String(t.labMoisture)),
    recheckMoistureStr: prompt(`第 ${t.seq} 趟 磅房复检水分%（原 ${t.recheckMoisture || '无'}，没有请留空）`, t.recheckMoisture || ''),
    pick: t.moistureChoice,
    impurityStr: prompt(`第 ${t.seq} 趟 杂质含率%（原 ${t.impurityPct}）`, String(t.impurityPct)),
    bulkStr: prompt(`第 ${t.seq} 趟 容重g/L（原 ${t.bulkValue}）`, String(t.bulkValue)),
  }));
  if (edited.some((e) => Object.values(e).some((v) => v === null))) {
    alert('已取消重开（重算必须从第一趟连续走完）。');
    return;
  }
  // 若某趟复检与化验对不上，必须当场点定
  for (let i = 0; i < edited.length; i++) {
    const e = edited[i];
    const lab = Number(e.labMoistureStr);
    const rec = e.recheckMoistureStr === '' ? null : Number(e.recheckMoistureStr);
    if (rec != null && !DRY.sameMoisture(lab, rec, state.params.moistureTolerance)) {
      const pick = prompt(`第 ${i + 1} 趟化验室 ${lab}% 与磅房 ${rec}% 对不上，请点定：输入 lab 用化验室，或 recheck 用磅房`, e.pick || 'lab');
      if (pick !== 'lab' && pick !== 'recheck') { alert('未点定水分，取消重开。'); return; }
      e.pick = pick;
    } else if (rec == null) {
      e.pick = '';
    }
  }

  const payload = load.trips.map((t, i) => {
    const e = edited[i];
    return {
      grossKg: e.grossKgStr,
      tareKg: e.tareKgStr,
      labMoisture: e.labMoistureStr,
      recheckMoisture: e.recheckMoistureStr,
      moistureChoice: e.pick,
      impurityPct: e.impurityStr,
      bulkValue: e.bulkStr,
    };
  });

  try {
    const nb = Store.reissueFromFirstTrip(state, oldBill.id, payload, new Date());
    Store.save(state);
    renderAll();
    openBill(nb.id);
  } catch (err) {
    alert(err.message);
  }
}

/* ---------- 挂牌价 ---------- */

function renderPrices() {
  $('priceRows').innerHTML = state.prices.slice().reverse().map((p) => `
    <tr><td>${p.date}</td>
      <td class="num">${p.pricePerTon}</td>
      <td class="num">${DRY.perTonToPerJin(p.pricePerTon)}</td></tr>`).join('');
  if (!$('priceDate').value) $('priceDate').value = DRY.dateStr(new Date());
}

$('setPriceBtn').addEventListener('click', () => {
  const date = $('priceDate').value;
  const perTon = Number($('priceValue').value);
  if (!date || !(perTon >= 0)) { alert('请填日期和每吨单价'); return; }
  Store.setPrice(state, date, perTon);
  $('priceValue').value = '';
  Store.save(state);
  renderAll();
});

/* ---------- 系数版本（第9条） ---------- */

function renderCoeffs() {
  const kindName = { moisture: '水分', impurity: '杂质' };
  const rows = [];
  for (const kind of ['moisture', 'impurity']) {
    state.coeffVersions[kind].forEach((v) => {
      rows.push(`<tr>
        <td>${kindName[kind]}扣量系数</td>
        <td class="num">×${v.coefficient}</td>
        <td>${new Date(v.effectiveAt).toLocaleString('zh-CN', { hour12: false })}</td>
        <td>${esc(v.note || '')}</td>
        <td class="hint">${new Date(v.effectiveAt) <= new Date() ? '已生效' : '未到生效时间'}</td>
      </tr>`);
    });
  }
  $('coeffRows').innerHTML = rows.join('');
}

$('addCoeffBtn').addEventListener('click', () => {
  const kind = $('coeffKind').value;
  const coeff = Number($('coeffValue').value);
  const atLocal = $('coeffTime').value;
  if (!(coeff > 0)) { alert('系数要大于 0'); return; }
  const effectiveAt = atLocal ? new Date(atLocal).toISOString() : new Date().toISOString();
  Store.addCoeffVersion(state, kind, coeff, effectiveAt, $('coeffNote').value);
  $('coeffValue').value = '';
  $('coeffNote').value = '';
  Store.save(state);
  renderAll();
});

/* ---------- 规则参数 ---------- */

function renderParams() {
  const p = state.params;
  const num = (key, label, step = '0.01') => `
    <label class="field">${label}
      <input type="number" step="${step}" data-param="${key}" value="${p[key]}"></label>`;
  $('moistureParams').innerHTML =
    num('grainName', '品种名称').replace('type="number" step="0.01"', 'type="text"') +
    num('safeMoisture', '安全水分(%)，以内不扣', '0.1') +
    num('rejectMoisture', '拒收水分(%)，超过拒收', '0.1') +
    num('moistureStep', '水分计档步长(个百分点)', '0.1') +
    num('moistureDeduction', '每档基础扣率(%)', '0.1') +
    num('moistureTolerance', '化验/磅房一致容差(个百分点)', '0.01');
  $('impurityParams').innerHTML =
    num('safeImpurity', '安全杂质(%)', '0.1') +
    num('impurityStep', '杂质计档步长(个百分点)', '0.1') +
    num('impurityDeduction', '杂质每档基础扣率(%)', '0.1');
  $('gradeRows').innerHTML = p.bulkGrades.map((g, idx) => `
    <tr>
      <td><input data-grade="${idx}" data-gf="name" value="${esc(g.name)}" style="width:80px"></td>
      <td class="num"><input type="number" data-grade="${idx}" data-gf="minBulk" value="${g.minBulk}" style="width:80px"></td>
      <td class="num"><input type="number" step="0.1" data-grade="${idx}" data-gf="deduction" value="${g.deduction}" style="width:70px"></td>
      <td><input type="checkbox" data-grade="${idx}" data-gf="rejects" ${g.rejects ? 'checked' : ''}></td>
    </tr>`).join('');

  document.querySelectorAll('[data-param]').forEach((input) => {
    input.onchange = () => {
      const key = input.dataset.param;
      Store.updateParams(state, { [key]: key === 'grainName' ? input.value : Number(input.value) });
      Store.save(state);
      renderAll();
    };
  });
  document.querySelectorAll('[data-grade]').forEach((input) => {
    input.onchange = () => {
      const idx = Number(input.dataset.grade);
      const f = input.dataset.gf;
      state.params.bulkGrades[idx][f] = f === 'name' ? input.value : (f === 'rejects' ? input.checked : Number(input.value));
      Store.save(state);
      renderAll();
    };
  });
}

/* ---------- tab 切换、单位切换 ---------- */

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

$('unitSelect').addEventListener('change', (e) => {
  state.unit = e.target.value; // 第7条：全局切换，所有未开单/列表行跟着换
  Store.save(state);
  renderAll();
});

$('resetDemoBtn').addEventListener('click', () => {
  if (!confirm('清空当前数据并恢复演示数据？')) return;
  state = Store.createInitialState();
  seedDemo(state);
  currentLoadId = null;
  Store.save(state);
  renderAll();
});

/* ---------- 演示数据 ---------- */

function seedDemo(s) {
  const today = DRY.dateStr(new Date());
  const yesterday = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return DRY.dateStr(d);
  })();
  Store.setPrice(s, yesterday, 1900);
  Store.setPrice(s, today, 2000);

  // 昨天系数 1.0，今早 08:00 起水分系数 1.2（演示第9条）
  const todayEight = `${today}T08:00:00`;
  Store.addCoeffVersion(s, 'moisture', 1.2, new Date(todayEight).toISOString(), '收购季调整');

  // 车1：一车两趟，已开单（昨天开出，切换单位/改系数都不动它）
  const l1 = Store.addLoad(s, { plateNo: '吉A·12345', driver: '张师傅' });
  Store.addTrip(s, l1.id, {
    grossKg: 21600, tareKg: 7800, labSheetNo: 'HY-101', labMoisture: 14,
    impurityPct: 1, bulkValue: 725,
    weighedAt: new Date(yesterday + 'T10:20').toISOString(),
  });
  Store.addTrip(s, l1.id, {
    grossKg: 19800, tareKg: 7800, labSheetNo: 'HY-102', labMoisture: 15.5,
    impurityPct: 1.5, bulkValue: 690,
    weighedAt: new Date(yesterday + 'T14:05').toISOString(),
  });
  const b1 = Store.issueBill(s, l1.id, new Date(yesterday + 'T16:00'));

  // 车2：未开单，化验室与磅房水分对不上，等人点（第4条）
  const l2 = Store.addLoad(s, { plateNo: '吉B·66888', driver: '李师傅' });
  Store.addTrip(s, l2.id, {
    grossKg: 20300, tareKg: 8100, labSheetNo: 'HY-201', labMoisture: 16.2,
    recheckSheetNo: 'BF-201', recheckMoisture: 18.0,
    impurityPct: 1, bulkValue: 700,
  });

  // 车3：水分超标拒收（第2条）
  const l3 = Store.addLoad(s, { plateNo: '吉C·90001', driver: '王师傅', basis: 'wet' });
  Store.addTrip(s, l3.id, {
    grossKg: 18000, tareKg: 7000, labSheetNo: 'HY-301', labMoisture: 31.5,
    impurityPct: 2, bulkValue: 640,
  });
  void b1;
}

/* ---------- 启动 ---------- */

Store.rollover(state, new Date());
setInterval(tick, 1000);
renderAll();
