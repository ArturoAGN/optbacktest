// backtest.js - reproducción + órdenes + P&L (SIN equity) + opción en Panel 4 SIEMPRE

document.addEventListener('DOMContentLoaded', () => {
  // Forzar apertura del datepicker (si el navegador lo soporta)
  document.querySelectorAll('input[type="date"]').forEach(el => {
    el.addEventListener('click', () => { if (el.showPicker) el.showPicker(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') el.value = ''; });
  });

  // ==== Tabs Órdenes/Trades ====
  const tabOrders = document.getElementById('tab-orders');
  const tabTrades = document.getElementById('tab-trades');
  const panelOrders = document.getElementById('panel-orders');
  const panelTrades = document.getElementById('panel-trades');

  function activateTab(which){
    const isOrders = (which === 'orders');
    if (tabOrders && tabTrades) {
      tabOrders.classList.toggle('active', isOrders);
      tabTrades.classList.toggle('active', !isOrders);
      tabOrders.setAttribute('aria-selected', isOrders ? 'true' : 'false');
      tabTrades.setAttribute('aria-selected', !isOrders ? 'true' : 'false');
    }
    if (panelOrders && panelTrades) {
      panelOrders.classList.toggle('active', isOrders);
      panelTrades.classList.toggle('active', !isOrders);
    }
  }
  if (tabOrders && tabTrades && panelOrders && panelTrades){
    tabOrders.addEventListener('click', ()=> activateTab('orders'));
    tabTrades.addEventListener('click', ()=> activateTab('trades'));
    activateTab('orders'); // por defecto
  }

  // ====== Contexto ======
  const ctxEl = document.getElementById('bt-context');
  if (!ctxEl) return;
  const BT = JSON.parse(ctxEl.textContent);

  const CH10  = BT.ch10  || null;
  const CH30  = BT.ch30  || null;
  const CH1D  = BT.ch1d  || null;
  const CHOPT = BT.chopt || null;
  const RB_HOURS = BT.rb_hours || [20,4];

  // ====== Utilidades ======
  const toMillis = (iso) => new Date(iso).getTime();
  const bisectRight = (arr, x) => { let lo=0, hi=arr.length; while(lo<hi){const mid=(lo+hi)>>>1; if(arr[mid]<=x) lo=mid+1; else hi=mid;} return lo-1; };
  const fmt = (n, d=2) => (n==null || isNaN(n) ? "—" : Number(n).toFixed(d));

  const X10 = CH10 ? CH10.x.map(toMillis) : [];
  const X30 = CH30 ? CH30.x.map(toMillis) : [];
  const XO  = CHOPT ? CHOPT.x.map(toMillis) : [];

  const { baseLayout, tracesFrom } = window.OptCharts;

  // ====== Estado de reproducción ======
  let idx = 1;
  let timer = null;
  let speed = 1;
  const BASE_MS = 600;

  // ====== Elementos UI ======
  const elTs  = document.getElementById('bt-ts');
  const elPx  = document.getElementById('bt-px');
  const elOpt = document.getElementById('bt-opt');
  const elPnL = document.getElementById('bt-pnl');

  // ====== Órdenes/posiciones ======
  const elSide  = document.getElementById('pos-side');
  const elQty   = document.getElementById('pos-qty');
  const elEntry = document.getElementById('pos-entry');
  const elMTM   = document.getElementById('pos-mtm');

  const state = {
    pos: { qty: 0, entry: null, source: 'under' },  // qty>0 long, qty<0 short
    realized: 0,
    params: { slip_bps: 0, comm_fixed: 0, comm_perunit: 0 }
  };

  const orders = [];
  const trades = [];

  // ====== Helpers financieros ======
  const multiplier = (source) => source === 'option' ? 100 : 1;

  function applySlippage(price, side, slip_bps){
    const m = (slip_bps||0)/10000;
    if (side === 'BUY')  return price * (1 + m);
    if (side === 'SELL') return price * (1 - m);
    return price;
  }
  function commissionTotal(qty, source, params){
    const perUnit = (params.comm_perunit||0) * Math.abs(qty) * multiplier(source);
    const fixed   = (params.comm_fixed||0);
    return perUnit + fixed;
  }

  function updateParamsFromUI(){
    state.params.slip_bps     = parseFloat(document.getElementById('slip-bps').value || '0');
    state.params.comm_fixed   = parseFloat(document.getElementById('comm-fixed').value || '0');
    state.params.comm_perunit = parseFloat(document.getElementById('comm-perunit').value || '0');
  }

  function markToMarket(lastPx){
    if (state.pos.qty === 0 || state.pos.entry == null) return 0;
    const pxDiff = (state.pos.qty > 0) ? (lastPx - state.pos.entry) : (state.pos.entry - lastPx);
    return pxDiff * Math.abs(state.pos.qty) * multiplier(state.pos.source);
  }

  function refreshPositionUI(){
    const side = state.pos.qty === 0 ? 'FLAT' : (state.pos.qty > 0 ? 'LONG' : 'SHORT');
    elSide.textContent  = side;
    elQty.textContent   = state.pos.qty;
    elEntry.textContent = (state.pos.entry==null ? '—' : state.pos.entry.toFixed(2));
  }

  function recalcPnL(pxUnder, pxOpt){
    const last = (state.pos.source === 'option' && pxOpt != null) ? pxOpt : pxUnder;
    const mtm = last==null ? 0 : markToMarket(last);
    elMTM.textContent = isNaN(mtm) ? '—' : mtm.toFixed(2);
    const total = state.realized + (isNaN(mtm) ? 0 : mtm);
    elPnL.textContent = total.toFixed(2);
    elPnL.className = (total >= 0) ? 'pnl-positive' : 'pnl-negative';
    return { mtm, total };
  }

  function recordTrade(closedQtySameSign, entryPx, exitPx){
    const id = orders.length + trades.length + 1;
    const side = (closedQtySameSign > 0) ? 'LONG' : 'SHORT';
    const qty  = Math.abs(closedQtySameSign);
    const pnl = (side === 'LONG')
      ? (exitPx - entryPx) * qty * multiplier(state.pos.source)
      : (entryPx - exitPx) * qty * multiplier(state.pos.source);

    trades.push({
      id, side, qty,
      entry_ts: elTs.textContent || '',
      entry_px: entryPx,
      exit_ts:  elTs.textContent || '',
      exit_px:  exitPx,
      pnl: pnl
    });
    renderTrades();
  }

  function realizeClose(qtyToClose, fillPx){
    const pnlPerUnit = (state.pos.qty > 0) ? (fillPx - state.pos.entry) : (state.pos.entry - fillPx);
    const pnlGross = pnlPerUnit * Math.abs(qtyToClose) * multiplier(state.pos.source);
    state.realized += pnlGross;
  }

  function consumeFillIntoPosition(side, qty, fillPx, source, comm){
    state.realized -= (comm || 0);

    if (state.pos.qty === 0){
      state.pos = { qty: qty, entry: fillPx, source };
      return;
    }
    if (state.pos.source !== source){
      realizeClose(state.pos.qty, fillPx);
      recordTrade(state.pos.qty, state.pos.entry, fillPx);
      state.pos = { qty: qty, entry: fillPx, source };
      return;
    }

    const newQty = state.pos.qty + qty;

    if ((state.pos.qty > 0 && newQty > 0) || (state.pos.qty < 0 && newQty < 0)){
      const oldAbs = Math.abs(state.pos.qty);
      const addAbs = Math.abs(qty);
      const newAbs = Math.abs(newQty);
      const newEntry = ((state.pos.entry * oldAbs) + (fillPx * addAbs)) / newAbs;
      state.pos.qty = newQty;
      state.pos.entry = newEntry;
      return;
    }

    const closingAbs = Math.min(Math.abs(state.pos.qty), Math.abs(qty));
    const closingQtySameSign = (state.pos.qty > 0) ? closingAbs : -closingAbs;

    realizeClose(closingQtySameSign, fillPx);

    const remainder = state.pos.qty + qty;
    if (remainder === 0){
      recordTrade(closingQtySameSign, state.pos.entry, fillPx);
      state.pos.qty = 0;
      state.pos.entry = null;
    } else {
      recordTrade(closingQtySameSign, state.pos.entry, fillPx);
      state.pos.qty = remainder;
      state.pos.entry = fillPx;
      state.pos.source = source;
    }
  }

  // ====== Órdenes ======
  const elOrdersBody = document.getElementById('orders-body');
  const elTradesBody = document.getElementById('trades-body');

  function placeOrder(side, type, price, qty, source, tif){
    const id = (orders.length + trades.length) + 1;
    const ts = CH10 ? CH10.x[Math.max(0, idx-1)] : '';
    orders.push({
      id, ts, side, type, price: (type === 'MKT' ? null : Number(price||0)),
      qty: Number(qty), source, tif, status: 'OPEN', fill_ts: null, fill_px: null
    });
    renderOrders();
  }
  function cancelOrder(id){
    const o = orders.find(x => x.id === id);
    if (o && o.status === 'OPEN'){ o.status = 'CANCELLED'; renderOrders(); }
  }
  function cancelAll(){ orders.forEach(o => { if (o.status==='OPEN') o.status='CANCELLED'; }); renderOrders(); }

  function tryFillOrderOnBar(o, bar){
    if (o.status !== 'OPEN') return false;
    if (o.type === 'MKT'){
      const raw = bar.c;
      const px = applySlippage(raw, o.side, state.params.slip_bps);
      const comm = commissionTotal(o.qty, o.source, state.params);
      doFill(o, bar.t, px, comm);
      return true;
    }
    if (o.type === 'LMT'){
      if (o.side === 'BUY' && bar.l <= o.price){
        const eff = (bar.o <= o.price) ? bar.o : o.price;
        const px = applySlippage(eff, o.side, state.params.slip_bps);
        const comm = commissionTotal(o.qty, o.source, state.params);
        doFill(o, bar.t, px, comm);
        return true;
      }
      if (o.side === 'SELL' && bar.h >= o.price){
        const eff = (bar.o >= o.price) ? bar.o : o.price;
        const px = applySlippage(eff, o.side, state.params.slip_bps);
        const comm = commissionTotal(o.qty, o.source, state.params);
        doFill(o, bar.t, px, comm);
        return true;
      }
    }
    if (o.type === 'STP'){
      if (o.side === 'BUY' && bar.h >= o.price){
        const eff = (bar.o >= o.price) ? bar.o : o.price;
        const px = applySlippage(eff, o.side, state.params.slip_bps);
        const comm = commissionTotal(o.qty, o.source, state.params);
        doFill(o, bar.t, px, comm);
        return true;
      }
      if (o.side === 'SELL' && bar.l <= o.price){
        const eff = (bar.o <= o.price) ? bar.o : o.price;
        const px = applySlippage(eff, o.side, state.params.slip_bps);
        const comm = commissionTotal(o.qty, o.source, state.params);
        doFill(o, bar.t, px, comm);
        return true;
      }
    }
    return false;
  }

  function doFill(o, ts, px, comm){
    o.status = 'FILLED';
    o.fill_ts = ts;
    o.fill_px = px;
    const signedQty = (o.side === 'BUY') ? Math.abs(o.qty) : -Math.abs(o.qty);
    consumeFillIntoPosition(o.side, signedQty, px, o.source, comm);
    renderOrders();
  }

  function getBar(source, i){
    if (source === 'option' && CHOPT) {
      return { o: CHOPT.open[i], h: CHOPT.high[i], l: CHOPT.low[i], c: CHOPT.close[i], t: CHOPT.x[i], ms: XO[i] };
    }
    return { o: CH10.open[i], h: CH10.high[i], l: CH10.low[i], c: CH10.close[i], t: CH10.x[i], ms: X10[i] };
  }
  function processOrdersOnCurrentBar(){
    const barUnder  = getBar('under',  idx-1);
    const barOption = (CHOPT ? getBar('option', Math.min(idx-1, CHOPT.x.length-1)) : null);
    for (const o of orders){
      if (o.status !== 'OPEN') continue;
      if (o.source === 'under'){ tryFillOrderOnBar(o, barUnder); }
      else if (o.source === 'option' && barOption){ tryFillOrderOnBar(o, barOption); }
    }
  }

  function renderOrders(){
    if (!elOrdersBody) return;
    elOrdersBody.innerHTML = '';
    for (const o of orders){
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${o.id}</td>
        <td>${o.ts || ''}</td>
        <td>${o.side}</td>
        <td>${o.type}</td>
        <td>${o.price==null?'—':o.price.toFixed(2)}</td>
        <td>${o.qty}</td>
        <td>${o.source}</td>
        <td>${o.status}</td>
        <td>${o.fill_ts || '—'}</td>
        <td>${o.fill_px==null?'—':o.fill_px.toFixed(2)}</td>
        <td>${o.status==='OPEN' ? `<button data-cancel="${o.id}" class="secondary">Cancelar</button>` : '—'}</td>
      `;
      elOrdersBody.appendChild(tr);
    }
    elOrdersBody.querySelectorAll('button[data-cancel]').forEach(btn => {
      btn.addEventListener('click', (e)=> {
        const id = parseInt(e.currentTarget.getAttribute('data-cancel'), 10);
        cancelOrder(id);
      });
    });
  }
  function renderTrades(){
    if (!elTradesBody) return;
    elTradesBody.innerHTML = '';
    for (const t of trades){
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${t.id}</td>
        <td>${t.side}</td>
        <td>${t.qty}</td>
        <td>${t.entry_ts}</td>
        <td>${t.entry_px.toFixed(2)}</td>
        <td>${t.exit_ts}</td>
        <td>${t.exit_px.toFixed(2)}</td>
        <td>${t.pnl.toFixed(2)}</td>
      `;
      elTradesBody.appendChild(tr);
    }
  }

  // ====== Export CSV ======
  function exportCSV(filename, rows, headers){
    const head = headers.map(h => `"${h}"`).join(',');
    const body = rows.map(r => headers.map(h => {
      const v = (r[h]!==undefined && r[h]!==null) ? r[h] : '';
      return `"${String(v).replace(/"/g,'""')}"`;
    }).join(',')).join('\n');
    const csv = head + '\n' + body;
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  const btnOrders = document.getElementById('btnExportOrders');
  const btnTrades = document.getElementById('btnExportTrades');
  if (btnOrders){
    btnOrders.addEventListener('click', () => {
      const rows = orders.map(o => ({ id:o.id, ts:o.ts, side:o.side, type:o.type, price:o.price, qty:o.qty, source:o.source, status:o.status, fill_ts:o.fill_ts, fill_px:o.fill_px }));
      exportCSV('orders.csv', rows, ['id','ts','side','type','price','qty','source','status','fill_ts','fill_px']);
    });
  }
  if (btnTrades){
    btnTrades.addEventListener('click', () => {
      const rows = trades.map(t => ({ id:t.id, side:t.side, qty:t.qty, entry_ts:t.entry_ts, entry_px:t.entry_px, exit_ts:t.exit_ts, exit_px:t.exit_px, pnl:t.pnl }));
      exportCSV('trades.csv', rows, ['id','side','qty','entry_ts','entry_px','exit_ts','exit_px','pnl']);
    });
  }

  // ====== Render de OPCIONES en Panel 4 (siempre) ======
  function renderOptionChart(uptoK){
    if (!CHOPT){ Plotly.purge('chart_opt'); return; }
    const k = (uptoK==null) ? 1 : Math.max(1, uptoK);
    Plotly.react('chart_opt',
      [
        { x: CHOPT.x.slice(0,k), open: CHOPT.open.slice(0,k), high: CHOPT.high.slice(0,k),
          low: CHOPT.low.slice(0,k), close: CHOPT.close.slice(0,k), type:'candlestick', name:'Precio', xaxis:'x', yaxis:'y1' },
        { x: CHOPT.x.slice(0,k), y: CHOPT.volume.slice(0,k), type:'bar', name:'Volumen', xaxis:'x', yaxis:'y2', opacity:0.4 }
      ],
      baseLayout(CHOPT.title || 'Opción', true, CHOPT, RB_HOURS),
      {responsive:true}
    );
  }

  // ====== Reproducción y sincronía ======
  function nearestIndex(arrTimes, tMs) { return (arrTimes && arrTimes.length) ? Math.max(0, bisectRight(arrTimes, tMs)) : -1; }

  function updateFrame(i){
    if (!CH10) return;
    idx = Math.max(1, Math.min(i, CH10.x.length));
    const tIso = CH10.x[idx-1];
    const tMs  = X10[idx-1];

    Plotly.react('chart_10m', tracesFrom(CH10, idx), baseLayout(CH10.title, true, CH10, RB_HOURS), {responsive:true});

    if (CH30) {
      const j = Math.max(1, nearestIndex(X30, tMs) + 1);
      Plotly.react('chart_30m', tracesFrom(CH30, j), baseLayout(CH30.title, true, CH30, RB_HOURS), {responsive:true});
    }

    if (CH1D) {
      Plotly.react('chart_1d', tracesFrom(CH1D, null), baseLayout(CH1D.title, false, CH1D, RB_HOURS), {responsive:true});
    }

    if (CHOPT) {
      const k = Math.max(1, nearestIndex(XO, tMs) + 1);
      renderOptionChart(k);
    } else {
      renderOptionChart(null);
    }

    const pxNowUnder = CH10 ? CH10.close[idx-1] : null;
    let pxNowOpt = null;
    if (CHOPT) {
      const k = Math.max(1, nearestIndex(XO, tMs) + 1);
      if (k>0) pxNowOpt = CHOPT.close[k-1];
    }

    elTs.textContent  = tIso || '—';
    elPx.textContent  = fmt(pxNowUnder);
    elOpt.textContent = fmt(pxNowOpt);

    processOrdersOnCurrentBar();
    recalcPnL(pxNowUnder, pxNowOpt);
    refreshPositionUI();
  }

  function play(){
    if (timer || !CH10) return;
    document.getElementById('btnPlay').disabled = true;
    document.getElementById('btnPause').disabled = false;
    timer = setInterval(() => {
      if (idx >= CH10.x.length) { pause(); return; }
      updateFrame(idx+1);
    }, BASE_MS / speed);
  }
  function pause(){
    if (timer){ clearInterval(timer); timer = null; }
    document.getElementById('btnPlay').disabled = false;
    document.getElementById('btnPause').disabled = true;
  }

  // Controles
  document.getElementById('btnStart').addEventListener('click', () => { pause(); updateFrame(1); });
  document.getElementById('btnBack').addEventListener('click',  () => { pause(); updateFrame(Math.max(1, idx-1)); });
  document.getElementById('btnFwd').addEventListener('click',   () => { pause(); updateFrame(idx+1); });
  document.getElementById('btnPlay').addEventListener('click',  play);
  document.getElementById('btnPause').addEventListener('click', pause);
  document.getElementById('speed').addEventListener('change', (e) => {
    speed = parseFloat(e.target.value || '1');
    if (timer) { pause(); play(); }
  });

  // Reset
  document.getElementById('btnReset').addEventListener('click', () => {
    pause();
    state.pos = { qty: 0, entry: null, source: 'under' };
    state.realized = 0;
    orders.length = 0; trades.length = 0;
    renderOrders(); renderTrades();
    idx = 1;
    updateFrame(1);
  });

  // Parámetros
  ['slip-bps','comm-fixed','comm-perunit'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', updateParamsFromUI);
  });
  updateParamsFromUI();

  // Órdenes rápidas (market)
  document.getElementById('btnBuy').addEventListener('click', () => {
    const qty = parseInt(document.getElementById('qty').value||'0',10);
    const source = document.getElementById('px-source').value;
    if (!qty) return;
    placeOrder('BUY','MKT',null,qty,source,'DAY');
    processOrdersOnCurrentBar();
    const tMs = X10[Math.max(1, idx)-1];
    const pxU = CH10 ? CH10.close[idx-1] : null;
    const k = CHOPT ? Math.max(0, nearestIndex(XO, tMs)) : -1;
    const pxO = (CHOPT && k>=0) ? CHOPT.close[k] : null;
    recalcPnL(pxU, pxO);
    refreshPositionUI();
  });
  document.getElementById('btnSell').addEventListener('click', () => {
    const qty = parseInt(document.getElementById('qty').value||'0',10);
    const source = document.getElementById('px-source').value;
    if (!qty) return;
    placeOrder('SELL','MKT',null,qty,source,'DAY');
    processOrdersOnCurrentBar();
    const tMs = X10[Math.max(1, idx)-1];
    const pxU = CH10 ? CH10.close[idx-1] : null;
    const k = CHOPT ? Math.max(0, nearestIndex(XO, tMs)) : -1;
    const pxO = (CHOPT && k>=0) ? CHOPT.close[k] : null;
    recalcPnL(pxU, pxO);
    refreshPositionUI();
  });
  document.getElementById('btnFlat').addEventListener('click', () => {
    const qtyToClose = state.pos.qty;
    if (qtyToClose === 0) return;
    const source = state.pos.source || document.getElementById('px-source').value;
    const side = qtyToClose > 0 ? 'SELL' : 'BUY';
    placeOrder(side,'MKT',null,Math.abs(qtyToClose),source,'DAY');
    processOrdersOnCurrentBar();
    const tMs = X10[Math.max(1, idx)-1];
    const pxU = CH10 ? CH10.close[idx-1] : null;
    const k = CHOPT ? Math.max(0, nearestIndex(XO, tMs)) : -1;
    const pxO = (CHOPT && k>=0) ? CHOPT.close[k] : null;
    recalcPnL(pxU, pxO);
    refreshPositionUI();
  });

  // Render inicial
  if (CH10)  Plotly.newPlot('chart_10m', tracesFrom(CH10, 1),   baseLayout(CH10.title,  true,  CH10,  RB_HOURS),  {responsive:true});
  if (CH30)  Plotly.newPlot('chart_30m', tracesFrom(CH30, 1),   baseLayout(CH30.title,  true,  CH30,  RB_HOURS),  {responsive:true});
  if (CH1D)  Plotly.newPlot('chart_1d',  tracesFrom(CH1D, null),baseLayout(CH1D.title,  false, CH1D, RB_HOURS),  {responsive:true});
  renderOptionChart(1);
  updateFrame(1);
});
