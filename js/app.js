/* 界面层 */
(function () {
  'use strict';
  var S = window.Store, GS = window.GS;
  var st = S.get();
  var currentDraftId = null;

  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function dtIso(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : ''; }

  // ---------- 单位/基称 展示 ----------
  function unitPrice(pricePerTon) {
    return st.prefs.unit === 'jin' ? GS.yuanPerTonToPerJin(pricePerTon) : pricePerTon;
  }
  function unitName() { return st.prefs.unit === 'jin' ? '元/斤' : '元/吨'; }
  function wName() { return st.prefs.unit === 'jin' ? '斤' : '吨'; }
  function weightDisp(kg) {
    var t = kg / 1000;
    return st.prefs.unit === 'jin' ? GS.round(GS.kgToJin(kg), 0) : GS.round(t, 3);
  }
  function billPriceDisp(bill, unit) {
    return unit === 'jin' ? GS.yuanPerTonToPerJin(bill.price) : bill.price;
  }
  function billWeightDisp(kg, unit) {
    return unit === 'jin' ? GS.round(GS.kgToJin(kg), 0) : GS.round(kg / 1000, 3);
  }
  function mDisp(mWet) {
    if (mWet == null) return '—';
    var v = st.prefs.basis === 'dry' ? GS.wetToDryBasis(mWet) : mWet;
    return GS.round(v, 2) + '%';
  }

  // ---------- 页签 ----------
  $('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-tab]');
    if (!b) return;
    document.querySelectorAll('#tabs button').forEach(function (x) { x.classList.toggle('active', x === b); });
    document.querySelectorAll('.tab').forEach(function (x) {
      x.classList.toggle('active', x.id === 'tab-' + b.dataset.tab);
    });
    renderAll();
  });

  // ---------- 全局单位/基称切换 ----------
  $('unitSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    S.setPrefs({ unit: b.dataset.unit });
    this.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
    renderAll();
  });
  $('basisSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    S.setPrefs({ basis: b.dataset.basis });
    this.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
    renderEditor();
  });

  // ---------- 结算列表 ----------
  function renderDrafts() {
    var box = $('draftList');
    box.innerHTML = '';
    if (!st.drafts.length) {
      box.appendChild(el('p', 'hint', '暂无在算车辆，点右上角“新车过磅”开始。'));
    }
    st.drafts.forEach(function (d) {
      var settle = GS.settleDraft(d, st.config, st.prices);
      var status;
      if (settle.rejected) status = '<span class="tag reject">超标拒收</span>';
      else if (!settle.ready && settle.note === 'NO_PRICE') status = '<span class="tag pending">当日无挂牌价</span>';
      else if (!settle.ready) status = '<span class="tag pending">水分待人工裁定</span>';
      else status = '<span class="tag safe">可开单</span>';
      var card = el('div', 'draft-card');
      card.innerHTML =
        '<div><b>' + esc(d.plate || '未填车牌') + '</b> ' + esc(d.driver || '') +
        ' ' + status + (d.recalcOf ? ' <span class="ref">重算自 ' + esc(d.recalcOf) + '</span>' : '') +
        '<div class="meta">建车 ' + dtIso(d.createdAt) + ' ｜ ' + d.trips.length + ' 趟过磅' +
        (settle.ready && !settle.rejected ? ' ｜ 结算重量 ' + weightDisp(settle.settleKg) + ' ' + wName() +
          ' ｜ 金额 ¥' + settle.amount.toFixed(2) : '') + '</div></div>';
      var acts = el('div', 'acts');
      var open = el('button', 'ghost', '打开');
      open.onclick = function () { currentDraftId = d.id; renderEditor(); };
      var del = el('button', 'danger', '作废删除');
      del.onclick = function () {
        if (confirm('删除这辆在算车？已开单据不受影响。')) {
          S.removeDraft(d.id);
          if (currentDraftId === d.id) { currentDraftId = null; $('draftEditor').classList.add('hidden'); }
          renderAll();
        }
      };
      acts.appendChild(open); acts.appendChild(del);
      card.appendChild(acts);
      box.appendChild(card);
    });
  }

  $('newDraftBtn').onclick = function () {
    var d = S.createDraft('', '');
    currentDraftId = d.id;
    renderAll();
  };
  $('closeEditor').onclick = function () { $('draftEditor').classList.add('hidden'); };

  // ---------- 车辆编辑器 ----------
  function headInput(id, val, oninput) {
    var i = $(id);
    i.value = val == null ? '' : val;
    i.oninput = oninput;
  }

  function renderEditor() {
    var d = currentDraftId ? S.getDraft(currentDraftId) : null;
    var ed = $('draftEditor');
    if (!d) { ed.classList.add('hidden'); return; }
    ed.classList.remove('hidden');
    $('editorTitle').textContent = (d.recalcOf ? '重算（' + d.recalcOf + ' → 新单）' : '车辆结算') +
      (d.plate ? ' · ' + d.plate : '');
    headInput('fPlate', d.plate, function () { S.updateDraft(d.id, { plate: this.value }); renderDrafts(); });
    headInput('fDriver', d.driver, function () { S.updateDraft(d.id, { driver: this.value }); renderDrafts(); });
    $('fGrain').value = st.config.grainName;
    $('fCreated').value = dtIso(d.createdAt);

    // 规则10/11 提示
    var rb = $('recalcBanner');
    if (d.recalcOf) {
      rb.classList.remove('hidden');
      rb.textContent = '本车为重算：新单于 ' + d.recalcOf + '，原单保留不改；只能从第一趟重新走，逐步重录后续趟次。';
    } else rb.classList.add('hidden');

    // 规则5：跨零点提示
    var today = GS.todayStr();
    var cb = $('crossDayBanner');
    if (d.businessDate !== today) {
      cb.classList.remove('hidden');
      cb.textContent = '本车建于 ' + d.businessDate + '，已过零点；开单将按今天（' + today + '）的挂牌价重算。';
    } else cb.classList.add('hidden');

    renderTrips(d);
    renderSummary(d);
  }

  $('addTripBtn').onclick = function () {
    var d = S.getDraft(currentDraftId);
    if (!d) return;
    S.upsertTrip(d.id, { gross: '', tare: '', moistureLab: '', labNo: '' });
    renderAll();
  };

  function renderTrips(d) {
    var box = $('tripRows');
    box.innerHTML = '';
    d.trips.forEach(function (t, idx) {
      var row = el('div', 'triprow');
      var dual = (t.moistureCheck != null && t.moistureLab != null &&
        Number(t.moistureCheck) !== Number(t.moistureLab));
      row.innerHTML =
        '<div class="row between"><b>第 ' + (idx + 1) + ' 趟</b>' +
        '<small class="muted">过磅 ' + dtIso(t.weighedAt) +
        ' ｜ 当时水分系数 ' + t.configSnapshot.moistureCoeff + '</small></div>' +
        '<div class="formgrid" style="margin-top:8px">' +
        fld('gross', '毛重 kg', t.gross) + fld('tare', '皮重 kg', t.tare) +
        '<label>水分 · 化验室（湿基%）<div class="dualm"><input data-k="moistureLab" value="' + (t.moistureLab == null ? '' : t.moistureLab) + '">' +
          '<input data-k="moistureCheck" title="磅房复检水分" placeholder="复检水分" value="' + (t.moistureCheck == null ? '' : t.moistureCheck) + '"></div></label>' +
        fld('density', '容重 g/L', t.density) + fld('impurity', '杂质 %', t.impurity) +
        fld('labNo', '化验单号', t.labNo) +
        '</div>';
      // 双水分裁定（规则4）
      if (dual) {
        var pick = el('div', 'banner warn');
        pick.innerHTML = '化验室 ' + mDisp(t.moistureLab) + ' 与磅房复检 ' + mDisp(t.moistureCheck) +
          ' 不一致，两个数并排待定，请人工点选采用：' +
          ' <button class="link" data-pick="lab">采用化验 ' + mDisp(t.moistureLab) + '</button>' +
          ' <button class="link" data-pick="check">采用复检 ' + mDisp(t.moistureCheck) + '</button>' +
          (t.moistureSource ? '（当前：' + (t.moistureSource === 'lab' ? '化验单' : '磅房复检') + '）' : '');
        pick.addEventListener('click', function (e) {
          var b = e.target.closest('button[data-pick]');
          if (!b) return;
          S.upsertTrip(d.id, Object.assign({}, t, { moistureSource: b.dataset.pick }));
          renderAll();
        });
        row.appendChild(pick);
      }
      // 输入自动保存
      row.querySelectorAll('input[data-k]').forEach(function (inp) {
        inp.addEventListener('change', function () {
          var patch = Object.assign({}, t);
          patch[inp.dataset.k] = inp.value === '' ? null : inp.value;
          S.upsertTrip(d.id, patch);
          renderAll();
        });
      });
      var res = GS.evaluateTrip(t, st.config);
      var info = el('div', 'tripresult');
      if (res.reason === 'MOISTURE_PENDING') info.innerHTML = '<span class="tag pending">等人工点水分</span>';
      else if (res.reason === 'MOISTURE_MISSING') info.innerHTML = '<span class="tag pending">缺水分化验单</span>';
      else if (res.rejected) info.innerHTML = '<span class="tag reject">水分 ' + res.moisture.value + '% 达拒收线</span>';
      else {
        info.innerHTML =
          '<span>净重 <b>' + res.net + ' kg</b></span>' +
          '<span>水分档 <b>' + res.moisture.value + '%（' +
            ({ safe: '安全', middle: '中间' })[res.moisture.cls] + '，扣 ' + (res.moisture.rate * 100).toFixed(2) + '%）</b></span>' +
          '<span>容重 <b>' + res.density.label + '（扣 ' + (res.density.rate * 100).toFixed(1) + '%）</b></span>' +
          '<span>杂质扣 <b>' + (res.impurity.rate * 100).toFixed(2) + '%</b></span>' +
          '<span>综合系数 <b>' + res.factor.toFixed(4) + '</b></span>' +
          '<span>折干结算 <b>' + res.settledKg + ' kg</b></span>' +
          '<span>化验单号 <b>' + esc(res.labNo || '未填') + '</b></span>';
      }
      row.appendChild(info);
      var delRow = el('div', 'row end');
      var db = el('button', 'danger', '删除本趟');
      db.onclick = function () { S.removeTrip(d.id, t.key); renderAll(); };
      delRow.appendChild(db);
      row.appendChild(delRow);
      box.appendChild(row);
    });
  }

  function fld(k, label, val) {
    return '<label>' + label + '<input data-k="' + k + '" value="' + (val == null ? '' : val) + '"></label>';
  }

  function renderSummary(d) {
    var settle = GS.settleDraft(d, st.config, st.prices);
    var box = $('summaryBox');
    var pb = $('pendingBox');
    box.innerHTML = '';
    pb.classList.add('hidden');
    var btn = $('issueBtn');

    if (settle.note === 'MOISTURE_PENDING') {
      pb.textContent = '有趟次化验室/磅房水分对不上，等人点定后才能开单。';
      pb.classList.remove('hidden');
    }
    if (settle.note === 'MOISTURE_MISSING') {
      pb.textContent = '有趟次还没填水分化验单。';
      pb.classList.remove('hidden');
    }
    if (settle.note === 'NO_PRICE') {
      pb.textContent = settle.priceDate + ' 还没有挂牌价，请到“挂牌价”页签登记当天价格。';
      pb.classList.remove('hidden');
    }

    var totalNet = settle.tripResults.reduce(function (a, t) { return a + (t.net || 0); }, 0);
    var cells = [
      ['总净重', weightDisp(totalNet) + ' ' + wName()],
      ['挂牌价(' + settle.priceDate + ')',
        settle.price != null ? unitPrice(settle.price).toFixed(st.prefs.unit === 'jin' ? 3 : 2) + ' ' + unitName() : '无当天价'],
      ['折干结算重量', settle.ready && !settle.rejected ? weightDisp(settle.settleKg) + ' ' + wName() : '—'],
      ['应付金额', settle.ready && !settle.rejected ? '¥ ' + settle.amount.toFixed(2) : settle.rejected ? '拒收，¥0' : '—']
    ];
    cells.forEach(function (c) {
      var x = el('div', '', '<div class="k">' + c[0] + '</div><div class="v">' + c[1] + '</div>');
      box.appendChild(x);
    });
    btn.disabled = !settle.ready;
    btn.textContent = settle.rejected ? '开具拒收单' : '开具结算单';
    btn.classList.toggle('danger', settle.rejected);
    btn.onclick = function () {
      var bill = S.issueBill(d.id, settle);
      if (bill) { currentDraftId = null; printBill(bill); renderAll(); }
    };
  }

  // ---------- 已开单据 ----------
  function renderBills() {
    var box = $('billList');
    box.innerHTML = '';
    if (!st.bills.length) { box.appendChild(el('p', 'hint', '还没有开过单据。')); return; }
    st.bills.forEach(function (b) {
      var card = el('div', 'bill');
      var u = b.unit || 'ton';
      var otherU = u === 'ton' ? 'jin' : 'ton';
      var rows = b.tripResults.map(function (t, i) {
        if (t.rejected) {
          return '<tr><td>' + (i + 1) + '</td><td>' + esc(t.labNo || '—') + '</td><td>' +
            (b.basis === 'dry' && t.moisture.value != null ? GS.round(GS.wetToDryBasis(t.moisture.value), 2) + '%' : (t.moisture.value == null ? '—' : t.moisture.value + '%')) +
            '（' + (b.basis === 'dry' ? '干基' : '湿基') + '）</td><td colspan="4" class="tag reject">水分超标拒收</td></tr>';
        }
        return '<tr><td>' + (i + 1) + '</td><td>' + esc(t.labNo || '—') + '</td><td>' +
          (b.basis === 'dry' ? GS.round(GS.wetToDryBasis(t.moisture.value), 2) + '%' : t.moisture.value + '%') +
          '（' + (b.basis === 'dry' ? '干基' : '湿基') + '）</td>' +
          '<td>' + t.net + '</td><td>' + (t.moisture.rate * 100).toFixed(2) + '%</td>' +
          '<td>' + t.density.label + ' ' + (t.density.rate * 100).toFixed(1) + '%</td>' +
          '<td>' + t.settledKg + '</td></tr>';
      }).join('');
      card.innerHTML =
        '<div class="hd"><div><b>单号 ' + esc(b.billNo) + '</b>' +
        (b.rejected ? ' <span class="tag reject">拒收单</span>' : '') +
        (b.recalcOf ? ' <span class="ref">重算自 ' + esc(b.recalcOf) + '（原单未改动）</span>' : '') +
        '</div><div class="muted">' + dtIso(b.issuedAt) + ' 开具</div></div>' +
        '<div class="muted" style="margin-top:4px">车牌 ' + esc(b.plate) + ' ｜ 司机 ' + esc(b.driver) +
          ' ｜ ' + esc(b.grain) + ' ｜ 计价日 ' + b.priceDate + '</div>' +
        '<table class="grid"><thead><tr><th>趟</th><th>化验单</th><th>采用水分</th>' +
          '<th>净重kg</th><th>水扣</th><th>容重</th><th>折干kg</th></tr></thead><tbody>' +
        rows + '</tbody></table>' +
        '<div class="summary"><div class="k">单价（开单时' + (u === 'ton' ? '元/吨' : '元/斤') + '）</div>' +
          '<div class="v">' + billPriceDisp(b, u).toFixed(u === 'ton' ? 2 : 3) +
          ' <small class="muted">≈' + billPriceDisp(b, otherU).toFixed(otherU === 'ton' ? 2 : 3) + (otherU === 'ton' ? ' 元/吨' : ' 元/斤') + '</small></div>' +
          '<div class="k">结算重量（开单时' + (u === 'ton' ? '吨' : '斤') + '）</div>' +
          '<div class="v">' + billWeightDisp(b.settleKg, u) +
          ' <small class="muted">≈' + billWeightDisp(b.settleKg, otherU) + (otherU === 'ton' ? ' 吨' : ' 斤') + '</small></div>' +
          '<div class="k">金额（元）</div><div class="v big">' + b.amount.toFixed(2) + '</div></div>';
      var acts = el('div', 'row end', '');
      var print = el('button', 'ghost', '补打');
      print.onclick = function () { printBill(b); };
      var rec = el('button', 'primary', '重算（另开新单）');
      rec.onclick = function () {
        if (!confirm('原单 ' + b.billNo + ' 保持不变，将另开一张新单，且必须从第一趟重新走。继续？')) return;
        var d = S.createRecalcDraft(b);
        currentDraftId = d.id;
        document.querySelector('#tabs button[data-tab="settle"]').click();
      };
      acts.appendChild(print); acts.appendChild(rec);
      card.appendChild(acts);
      box.appendChild(card);
    });
  }

  // ---------- 打印 ----------
  function printBill(b) {
    var area = $('printArea');
    var basisLabel = b.basis === 'dry' ? '干基报' : '湿基报';
    var tripLines = b.tripResults.map(function (t, i) {
      if (t.rejected) {
        return '<tr><td>' + (i + 1) + '</td><td>' + esc(t.labNo || '—') + '</td><td>' +
          (b.basis === 'dry' ? GS.round(GS.wetToDryBasis(t.moisture.value), 2) : t.moisture.value) + '%</td>' +
          '<td>' + t.net + '</td><td colspan="3">水分超标，拒收</td></tr>';
      }
      return '<tr><td>' + (i + 1) + '</td><td>' + esc(t.labNo || '—') + '</td><td>' +
        (b.basis === 'dry' ? GS.round(GS.wetToDryBasis(t.moisture.value), 2) : t.moisture.value) + '%</td>' +
        '<td>' + t.net + '</td><td>' + (t.moisture.rate * 100).toFixed(2) + '% / ' + t.density.label +
        (t.density.rate * 100).toFixed(1) + '% / ' + (t.impurity.rate * 100).toFixed(2) + '%</td>' +
        '<td>' + t.settledKg + '</td></tr>';
    }).join('');
    area.innerHTML =
      '<div class="no-print" style="text-align:right;margin-bottom:10px">' +
      '<button class="primary" onclick="window.print()">打印</button> ' +
      '<button class="ghost" onclick="document.getElementById(\'printArea\').classList.add(\'hidden\')">关闭</button></div>' +
      '<h2 style="text-align:center">' + esc(b.grain) + '潮粮折干结算' + (b.rejected ? '（拒收单）' : '') + '</h2>' +
      '<p>单号：<b>' + esc(b.billNo) + '</b>' +
      (b.recalcOf ? '　重算自原单：<b>' + esc(b.recalcOf) + '</b>' : '') +
      '　计价日期：' + b.priceDate + '　开单时间：' + dtIso(b.issuedAt) + '</p>' +
      '<p>车牌：' + esc(b.plate) + '　司机：' + esc(b.driver) +
      '　水分报法：<b>' + basisLabel + '</b>（各趟化验单号见下表）</p>' +
      '<table class="grid"><thead><tr><th>趟次</th><th>化验单号</th><th>采用水分(' + basisLabel + ')</th>' +
      '<th>净重kg</th><th>水扣/容重/杂扣</th><th>折干kg</th></tr></thead><tbody>' +
      tripLines + '</tbody></table>' +
      (b.rejected ? '<p style="color:#b3261e;font-size:16px"><b>本车水分超标，按拒收处理，不予结算。</b></p>' :
      '<p style="font-size:16px">单价 ' + b.price.toFixed(2) + ' 元/吨' +
      '（≈' + GS.yuanPerTonToPerJin(b.price).toFixed(3) + ' 元/斤）；' +
      '结算重量 ' + GS.round(b.settleKg / 1000, 3) + ' 吨' +
      '（' + GS.kgToJin(b.settleKg) + ' 斤）；' +
      '<b>应付金额 ¥' + b.amount.toFixed(2) + '</b></p>') +
      '<p>结算员：________　司机签字：________　日期：________</p>';
    area.classList.remove('hidden');
    setTimeout(function () { window.print(); }, 100);
  }

  // ---------- 挂牌价 ----------
  function renderPrices() {
    $('priceDate').value = GS.todayStr();
    var tb = $('priceTable').querySelector('tbody');
    tb.innerHTML = '';
    Object.keys(st.prices).sort().reverse().forEach(function (d) {
      var tr = el('tr');
      tr.innerHTML = '<td>' + d + '</td><td>' + st.prices[d].toFixed(2) + '</td>' +
        '<td>' + GS.yuanPerTonToPerJin(st.prices[d]).toFixed(3) + '</td><td></td>';
      var del = el('button', 'danger', '删除');
      del.onclick = function () { delete st.prices[d]; S.save(); renderPrices(); };
      tr.lastElementChild.appendChild(del);
      tb.appendChild(tr);
    });
  }
  $('savePriceBtn').onclick = function () {
    var d = $('priceDate').value, v = $('priceValue').value;
    if (!d || v === '') return alert('请填日期和单价');
    var perTon = st.prefs.unit === 'jin' ? GS.yuanPerJinToPerTon(v) : Number(v);
    S.setPrice(d, perTon);
    $('priceValue').value = '';
    renderPrices(); renderDrafts();
  };
  // 单位切换时更新挂牌价输入提示
  var origRenderAll = null;

  // ---------- 标准设置 ----------
  function renderSettings() {
    $('cfgGrain').value = st.config.grainName;
    $('cfgSafe').value = st.config.safeMoisture;
    $('cfgReject').value = st.config.rejectMoisture;
    $('cfgMC').value = st.config.moistureCoeff;
    $('cfgBaseImp').value = st.config.baseImpurity;
    $('cfgImpC').value = st.config.impurityCoeff;
    var box = $('cfgGrades');
    box.innerHTML = '';
    st.config.densityGrades.forEach(function (g, i) {
      var row = el('div', 'formgrid', '');
      row.style.marginBottom = '8px';
      row.innerHTML =
        '<label>名称<input data-i="' + i + '" data-k="label" value="' + esc(g.label) + '"></label>' +
        '<label>容重≥ g/L<input data-i="' + i + '" data-k="min" type="number" value="' + g.min + '"></label>' +
        '<label>扣率(如0.01=1%)<input data-i="' + i + '" data-k="deduct" type="number" step="0.005" value="' + g.deduct + '"></label>';
      box.appendChild(row);
    });
  }
  $('saveCfgBtn').onclick = function () {
    var grades = st.config.densityGrades.map(function (g, i) {
      var inputs = $('cfgGrades').querySelectorAll('input[data-i="' + i + '"]');
      var o = Object.assign({}, g);
      inputs.forEach(function (inp) {
        o[inp.dataset.k] = inp.dataset.k === 'label' ? inp.value : Number(inp.value);
      });
      return o;
    }).sort(function (a, b) { return b.min - a.min; });
    S.updateConfig({
      grainName: $('cfgGrain').value,
      safeMoisture: Number($('cfgSafe').value),
      rejectMoisture: Number($('cfgReject').value),
      moistureCoeff: Number($('cfgMC').value),
      baseImpurity: Number($('cfgBaseImp').value),
      impurityCoeff: Number($('cfgImpC').value),
      densityGrades: grades
    });
    alert('标准已保存。新系数只对之后过磅的趟次生效；已保存趟次按其过磅时系数，已开单据不动。');
    renderAll();
  };

  // ---------- 数据 ----------
  $('exportBtn').onclick = function () {
    var blob = new Blob([S.exportAll()], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'chaoliang-zhegan-' + GS.todayStr() + '.json';
    a.click();
  };
  $('importBtn').onclick = function () { $('importFile').click(); };
  $('importFile').onchange = function () {
    var f = this.files[0]; if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      try { S.importAll(r.result); st = S.get(); alert('导入成功'); renderAll(); }
      catch (e) { alert('导入失败：' + e.message); }
    };
    r.readAsText(f);
  };
  $('clearBtn').onclick = function () {
    if (confirm('确定清空全部车辆、单据、价格和设置？不可恢复，建议先导出备份。')) {
      S.clearAll(); st = S.get(); renderAll();
    }
  };

  // ---------- 总渲染 ----------
  function renderAll() {
    st = S.get();
    document.querySelectorAll('#unitSeg button').forEach(function (x) {
      x.classList.toggle('on', x.dataset.unit === st.prefs.unit);
    });
    document.querySelectorAll('#basisSeg button').forEach(function (x) {
      x.classList.toggle('on', x.dataset.basis === st.prefs.basis);
    });
    $('priceUnitLabel').textContent = st.prefs.unit === 'jin' ? '元/斤' : '元/吨';
    renderDrafts();
    renderEditor();
    renderBills();
    renderPrices();
    renderSettings();
  }
  renderAll();
})();
