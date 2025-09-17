// backtest.js - motor de reproducción + órdenes avanzadas + P&L + export CSV

document.addEventListener('DOMContentLoaded', () => {
  // Date pickers: apertura forzada (si el navegador lo soporta)
  document.querySelectorAll('input[type="date"]').forEach(el => {
    el.addEventListener('click', () => { if (el.showPicker) el.showPicker(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') el.value = ''; });
  });

  const ctxEl = document.getElementById('bt-context');
  if (!ctxEl) return; // página sin datos aún
  const BT = JSON.parse(ctxEl.textContent);

  const CH10  = BT.ch10  || null;
  const CH30  = BT.ch30  || null;
  const CH1D  = BT.ch1d  || null;
  const CHOPT = BT.chopt || null;
  const RB_HOURS = BT.rb_hours || [20,4];

  const { baseLayout, tracesFrom } = window.OptCharts;

  // Utilidades
  const toMillis = (iso) => new Date(iso).getTime();
  const bisectRight = (arr, x) => { let lo=0, hi=arr.length; while(lo<hi){const mid=(lo+hi)>>>1; if(arr[mid]<=x) lo=mid+1; else hi=mid;} return lo-1; };
  const fmt = (n, d=2) => (n==null || isNaN(n) ? "—" : Number(n).toFixed(d));
  const uid = (() => { let i=1; return () => i++; })();

  const X10 = CH10 ? CH10.x.map(toMillis) : [];
  const X30 = CH30 ? CH30.x.map(toMillis) : [];
  const XO  = CHOPT ? CHOPT.x.map(toMillis) : [];

  const getBar = (source, idx) => {
    if (source === 'option' && CHOPT) {
      return { o: CHOPT.open[idx], h: CHOPT.high[idx], l: CHOPT.low[idx], c: CHOPT.close[idx], t: CHOPT.x[idx], ms: XO[idx] };
    }
    return { o: CH10.open[idx], h: CH10.high[idx], l: CH10.low[idx], c: CH10.close[idx], t: CH10.x[idx], ms: X10[idx] };
  };

  // Render inicial
  if (CH10)  Plotly.newPlot('chart_10m', tracesFrom(CH10, 1),   baseLayout(CH10.title,  true,  CH10,  RB_HOURS),  {responsive:true});
  if (CH30)  Plotly.newPlot('chart_30m', tracesFrom(CH30, 1),   baseLayout(CH30.title,  true,  CH30,  RB_HOURS),  {responsive:true});
  if (CH1D)  Plotly.newPlot('chart_1d',  tracesFrom(CH1D, null),baseLayout(CH1D.title,  false, CH1D, RB_HOURS),  {responsive:true});
  if (CHOPT) Plotly.newPlot('chart_opt', tracesFrom(CHOPT, 1),  baseLayout(CHOPT.title, true,  CHOPT, RB_HOURS), {responsive:true});

  // ====== Estado de reproducción ======
  let idx = 1;                       // empieza en la primera vela completa
  let timer = null;
  let speed = 1;                     // 1x = 600ms por paso
  const BASE_MS = 600;

  const elTs  = document.getElementById('bt-ts');
  const elPx  = document.getElementById('bt-px');
  const elOpt = document.getElementById('bt-opt');
  const elPnL = document.getElementById('bt-pnl');

  function current10mClose(i) { return CH10 ? CH10.close[i] : null; }
  function current10mTs(i)    { return CH10 ? CH10.x[i]     : null; }
  const nearestIndex = (arrTimes, tMs) => (arrTimes && arrTimes.length) ? Math.max(0, bisectRight(arrTimes, tMs)) : -1;

  // ====== Estado de órdenes/posiciones ======
  const elSide  = document.getElementById('pos-side');
  const elQty   = document.getElementById('pos-qty');
  const elEntry = document.getElementById('pos-entry');
  const elMTM   = document.getElementById('pos-mtm');

  const state = {
    pos: { qty: 0, entry: null, source: 'under' },  // qty>0 long, qty<0 short
    realized: 0,
    params: {
      slip_bps: 0,
      comm_fixed: 0,
      comm_perunit: 0,
    }
  };

  const orders = [];  // lista de órdenes
  const trades = [];  // lista de trades (cuando pos vuelve a 0)

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
    state.params.slip_bps   = parseFloat(document.getElementById('slip-bps').value || '0');
    state.params.comm_fixed = parseFloat(document.getElementById('comm-fixed').value || '0');
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
  }

  function realizeClose(qtyToClose, fillPx){
    // qtyToClose tiene el mismo signo que la posición actual (positivo si long)
    const pnlPerUnit = (state.pos.qty > 0) ? (fillPx - state.pos.entry) : (state.pos.entry - fillPx);
    const pnlGross = pnlPerUnit * Math.abs(qtyToClose) * multiplier(state.pos.source);
    state.realized += pnlGross;
  }

  function consumeFillIntoPosition(side, qty, fillPx, source, comm){
    // qty >0 para BUY, <0 para SELL
    // suma comisiones
    state.realized -= (comm || 0);

    if (state.pos.qty === 0){
      // abre nueva posición
      state.pos = { qty: qty, entry: fillPx, source };
      return;
    }

    // Si cambia de activo (subyacente vs opción), forcemos cerrar y reabrir
    if (state.pos.source !== source){
      // cerrar todo al fillPx y abrir nueva
      realizeClose(state.pos.qty, fillPx);
      // registrar trade
      recordTrade(state.pos.qty, state.pos.entry, fillPx);
      state.pos = { qty: qty, entry: fillPx, source };
      return;
    }

    const newQty = state.pos.qty + qty;

    // Misma dirección => promediar
    if ((state.pos.qty > 0 && newQty > 0) || (state.pos.qty < 0 && newQty < 0)){
      const oldAbs = Math.abs(state.pos.qty);
      const addAbs = Math.abs(qty);
      const newAbs = Math.abs(newQty);
      const newEntry = ((state.pos.entry * oldAbs) + (fillPx * addAbs)) / newAbs;
      state.pos.qty = newQty;
      state.pos.entry = newEntry;
      return;
    }

    // Dirección opuesta => cierre parcial o total
    const closingAbs = Math.min(Math.abs(state.pos.qty), Math.abs(qty));
    const closingQtySameSign = (state.pos.qty > 0) ? closingAbs : -closingAbs; // signo de la posición

    // Realizar P&L por la parte que cierra
    realizeClose(closingQtySameSign, fillPx);

    // Si queda posición en la dirección contraria, abre con el remanente
    const remainder = state.pos.qty + qty; // puede ser 0 (cierre total) o signo contrario
    if (remainder === 0){
      // registrar trade completo
      recordTrade(closingQtySameSign, state.pos.entry, fillPx);
      state.pos.qty = 0;
      state.pos.entry = null;
    } else {
      // trade cerrado por la parte correspondiente
      recordTrade(closingQtySameSign, state.pos.entry, fillPx);
      // abrir nueva con el remanente al precio de fill
      state.pos.qty = remainder;
      state.pos.entry = fillPx;
      state.pos.source = source;
    }
  }

  function recordTrade(closedQtySameSign, entryPx, exitPx){
    // closedQtySameSign conserva el signo de la posición cerrada
    const id = uid();
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

  // ====== Órdenes ======
  function placeOrder(side, type, price, qty, source, tif){
    const id = uid();
    const ts = current10mTs(idx-1);
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
    // Lógica de fill por tipo
    if (o.type === 'MKT'){
      // Market: llenamos al close de la barra actual
      const raw = bar.c;
      const px = applySlippage(raw, o.side, state.params.slip_bps);
      const comm = commissionTotal(o.qty, o.source, state.params);
      doFill(o, bar.t, px, comm);
      return true;
    }
    if (o.type === 'LMT'){
      // BUY-LIMIT: se ejecuta si l <= price; SELL-LIMIT: si h >= price
      if (o.side === 'BUY' && bar.l <= o.price){
        const eff = (bar.o <= o.price) ? bar.o : o.price; // posible mejora
        const px = applySlippage(eff, o.side, state.params.slip_bps);
        const comm = commissionTotal(o.qty, o.source, state.params);
        doFill(o, bar.t, px, comm);
        return true;
      }
      if (o.side === 'SELL' && bar.h >= o.price){
        const eff = (bar.o >= o.price) ? bar.o : o.price; // posible mejora
        const px = applySlippage(eff, o.side, state.params.slip_bps);
        const comm = commissionTotal(o.qty, o.source, state.params);
        doFill(o, bar.t, px, comm);
        return true;
      }
    }
    if (o.type === 'STP'){
      // BUY-STOP: se activa si h >= price -> fill a max(open, price)
      if (o.side === 'BUY' && bar.h >= o.price){
        const eff = (bar.o >= o.price) ? bar.o : o.price; // peor caso
        const px = applySlippage(eff, o.side, state.params.slip_bps);
        const comm = commissionTotal(o.qty, o.source, state.params);
        doFill(o, bar.t, px, comm);
        return true;
      }
      // SELL-STOP: se activa si l <= price -> fill a min(open, price)
      if (o.side === 'SELL' && bar.l <= o.price){
        const eff = (bar.o <= o.price) ? bar.o : o.price; // peor caso
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

  function processOrdersOnCurrentBar(){
    // Procesa sobre el activo de cada orden (subyacente u opción)
    const barUnder = getBar('under', idx-1);
    const barOption = CHOPT ? getBar('option', Math.min(idx-1, CHOPT.x.length-1)) : null;

    for (const o of orders){
      if (o.status !== 'OPEN') continue;
      if (o.source === 'under'){ tryFillOrderOnBar(o, barUnder); }
      else if (o.source === 'option' && barOption){ tryFillOrderOnBar(o, barOption); }
    }
  }

  // ====== Render de tablas ======
  const elOrdersBody = document.getElementById('orders-body');
  const elTradesBody = document.getElementById('trades-body');

  function renderOrders(){
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
    // wire de cancelar
    elOrdersBody.querySelectorAll('button[data-cancel]').forEach(btn => {
      btn.addEventListener('click', (e)=> {
        const id = parseInt(e.currentTarget.getAttribute('data-cancel'), 10);
        cancelOrder(id);
      });
    });
  }

  function renderTrades(){
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

  document.getElementById('btnExportOrders').addEventListener('click', () => {
    const rows = orders.map(o => ({
      id:o.id, ts:o.ts, side:o.side, type:o.type, price:o.price, qty:o.qty, source:o.source, status:o.status, fill_ts:o.fill_ts, fill_px:o.fill_px
    }));
    exportCSV('orders.csv', rows, ['id','ts','side','type','price','qty','source','status','fill_ts','fill_px']);
  });
  document.getElementById('btnExportTrades').addEventListener('click', () => {
    const rows = trades.map(t => ({
      id:t.id, side:t.side, qty:t.qty, entry_ts:t.entry_ts, entry_px:t.entry_px, exit_ts:t.exit_ts, exit_px:t.exit_px, pnl:t.pnl
    }));
    exportCSV('trades.csv', rows, ['id','side','qty','entry_ts','entry_px','exit_ts','exit_px','pnl']);
  });

  // ====== Interacciones UI ======
  // Parámetros
  ['slip-bps','comm-fixed','comm-perunit'].forEach(id => {
    document.getElementById(id).addEventListener('change', updateParamsFromUI);
  });
  updateParamsFromUI();

  // Órdenes rápidas (market inmediato)
  document.getElementById('px-source').addEventListener('change', (e) => {
    // La posición mantendrá su source actual hasta cerrar;
    // las nuevas órdenes usan el source seleccionado
  });
  document.getElementById('qty').addEventListener('change', () => { /* se lee al usar */ });

  document.getElementById('btnBuy').addEventListener('click', () => {
    const qty = parseInt(document.getElementById('qty').value||'0',10);
    const source = document.getElementById('px-source').value;
    if (!qty) return;
    placeOrder('BUY','MKT',null,qty,source,'DAY');
    // Procesar de inmediato en la barra actual
    processOrdersOnCurrentBar();
    const pxU = CH10.close[idx-1];
    const pxO = (CHOPT && XO.length) ? (() => { const k=nearestIndex(XO, X10[idx-1]); return k>=0?CHOPT.close[k]:null; })() : null;
    recalcPnL(pxU, pxO);
    refreshPositionUI();
  });
  document.getElementById('btnSell').addEventListener('click', () => {
    const qty = parseInt(document.getElementById('qty').value||'0',10);
    const source = document.getElementById('px-source').value;
    if (!qty) return;
    placeOrder('SELL','MKT',null,qty,source,'DAY');
    processOrdersOnCurrentBar();
    const pxU = CH10.close[idx-1];
    const pxO = (CHOPT && XO.length) ? (() => { const k=nearestIndex(XO, X10[idx-1]); return k>=0?CHOPT.close[k]:null; })() : null;
    recalcPnL(pxU, pxO);
    refreshPositionUI();
  });
  document.getElementById('btnFlat').addEventListener('click', () => {
    // cerrar posición al precio de la barra actual
    const source = state.pos.source || document.getElementById('px-source').value;
    const qtyToClose = state.pos.qty;
    if (qtyToClose === 0) return;
    const side = qtyToClose > 0 ? 'SELL' : 'BUY';
    placeOrder(side,'MKT',null,Math.abs(qtyToClose),source,'DAY');
    processOrdersOnCurrentBar();
    const pxU = CH10.close[idx-1];
    const pxO = (CHOPT && XO.length) ? (() => { const k=nearestIndex(XO, X10[idx-1]); return k>=0?CHOPT.close[k]:null; })() : null;
    recalcPnL(pxU, pxO);
    refreshPositionUI();
  });

  // Órdenes avanzadas
  document.getElementById('btnPlaceBuy').addEventListener('click', () => {
    const type = document.getElementById('ord-type').value;
    const price = document.getElementById('ord-price').value;
    const tif = document.getElementById('ord-tif').value;
    const qty = parseInt(document.getElementById('qty').value||'0',10);
    const source = document.getElementById('px-source').value;
    if (!qty) return;
    placeOrder('BUY', type, price, qty, source, tif);
    renderOrders();
  });
  document.getElementById('btnPlaceSell').addEventListener('click', () => {
    const type = document.getElementById('ord-type').value;
    const price = document.getElementById('ord-price').value;
    const tif = document.getElementById('ord-tif').value;
    const qty = parseInt(document.getElementById('qty').value||'0',10);
    const source = document.getElementById('px-source').value;
    if (!qty) return;
    placeOrder('SELL', type, price, qty, source, tif);
    renderOrders();
  });
  document.getElementById('btnCancelAll').addEventListener('click', cancelAll);

  // ====== Reproducción y sincronía ======
  function updateFrame(i){
    if (!CH10) return;
    idx = Math.max(1, Math.min(i, CH10.x.length));
    const tIso = current10mTs(idx-1);
    const tMs  = X10[idx-1];

    Plotly.react('chart_10m', tracesFrom(CH10, idx), baseLayout(CH10.title, true, CH10, RB_HOURS), {responsive:true});

    if (CH30) {
      const j = Math.max(1, nearestIndex(X30, tMs) + 1);
      Plotly.react('chart_30m', tracesFrom(CH30, j), baseLayout(CH30.title, true, CH30, RB_HOURS), {responsive:true});
    }

    let optPxNow = null;
    if (CHOPT) {
      const k = Math.max(1, nearestIndex(XO, tMs) + 1);
      Plotly.react('chart_opt', tracesFrom(CHOPT, k), baseLayout(CHOPT.title, true, CHOPT, RB_HOURS), {responsive:true});
      if (k>0) optPxNow = CHOPT.close[k-1];
    }

    // Status line
    const pxNow = current10mClose(idx-1);
    elTs.textContent  = tIso || '—';
    elPx.textContent  = fmt(pxNow);
    elOpt.textContent = fmt(optPxNow);

    // Procesar órdenes en esta barra
    processOrdersOnCurrentBar();

    // Recalcular MTM/P&L
    recalcPnL(pxNow, optPxNow);
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

  // Controles de reproducción
  document.getElementById('btnStart').addEventListener('click', () => { pause(); updateFrame(1); });
  document.getElementById('btnBack').addEventListener('click',  () => { pause(); updateFrame(Math.max(1, idx-1)); });
  document.getElementById('btnFwd').addEventListener('click',   () => { pause(); updateFrame(idx+1); });
  document.getElementById('btnPlay').addEventListener('click',  play);
  document.getElementById('btnPause').addEventListener('click', pause);
  document.getElementById('speed').addEventListener('change', (e) => {
    speed = parseFloat(e.target.value || '1');
    if (timer) { pause(); play(); }
  });

  // Inicial
  updateFrame(1);
});
