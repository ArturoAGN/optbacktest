// backtest.js - motor de reproducción + P&L y wiring del UI

document.addEventListener('DOMContentLoaded', () => {
  // Date pickers: apertura forzada (si el navegador lo soporta) y edición manual
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

  const X10 = CH10 ? CH10.x.map(toMillis) : [];
  const X30 = CH30 ? CH30.x.map(toMillis) : [];
  const XO  = CHOPT ? CHOPT.x.map(toMillis) : [];

  // Render inicial
  if (CH10)  Plotly.newPlot('chart_10m', tracesFrom(CH10, 1),   baseLayout(CH10.title,  true,  CH10,  RB_HOURS),  {responsive:true});
  if (CH30)  Plotly.newPlot('chart_30m', tracesFrom(CH30, 1),   baseLayout(CH30.title,  true,  CH30,  RB_HOURS),  {responsive:true});
  if (CH1D)  Plotly.newPlot('chart_1d',  tracesFrom(CH1D, null),baseLayout(CH1D.title,  false, CH1D, RB_HOURS),  {responsive:true});
  if (CHOPT) Plotly.newPlot('chart_opt', tracesFrom(CHOPT, 1),  baseLayout(CHOPT.title, true,  CHOPT, RB_HOURS), {responsive:true});

  // ====== Motor de reproducción sincronizada ======
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

  function updateFrame(i){
    if (!CH10) return;
    idx = Math.max(1, Math.min(i, CH10.x.length));
    const tIso = current10mTs(idx-1);
    const tMs  = X10[idx-1];

    Plotly.react('chart_10m', tracesFrom(CH10, idx), baseLayout(CH10.title, true, CH10, RB_HOURS), {responsive:true});

    if (CH30) {
      const j = nearestIndex(X30, tMs) + 1;
      Plotly.react('chart_30m', tracesFrom(CH30, j), baseLayout(CH30.title, true, CH30, RB_HOURS), {responsive:true});
    }

    let optPxNow = null;
    if (CHOPT) {
      const k = nearestIndex(XO, tMs) + 1;
      Plotly.react('chart_opt', tracesFrom(CHOPT, k), baseLayout(CHOPT.title, true, CHOPT, RB_HOURS), {responsive:true});
      if (k>0) optPxNow = CHOPT.close[k-1];
    }

    const pxNow = current10mClose(idx-1);
    elTs.textContent  = tIso || '—';
    elPx.textContent  = fmt(pxNow);
    elOpt.textContent = fmt(optPxNow);

    recalcPnL(pxNow, optPxNow);
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

  // ====== P&L mark-to-market ======
  const elSide  = document.getElementById('pos-side');
  const elQty   = document.getElementById('pos-qty');
  const elEntry = document.getElementById('pos-entry');
  const elMTM   = document.getElementById('pos-mtm');

  const state = {
    side: 'FLAT',     // FLAT | LONG | SHORT
    qty: 0,
    entry: null,      // precio de entrada
    source: 'under',  // 'under' | 'option'
    realized: 0
  };

  function assetPrice(pxUnder, pxOpt){
    return (state.source === 'option' && pxOpt != null) ? pxOpt : pxUnder;
  }
  function multiplier(){ return (state.source === 'option') ? 100 : 1; }
  function markToMarket(pxUnder, pxOpt){
    if (state.side === 'FLAT' || state.qty === 0 || state.entry == null) return 0;
    const last = assetPrice(pxUnder, pxOpt);
    if (last == null) return 0;
    const pxDiff = (state.side === 'LONG') ? (last - state.entry) : (state.entry - last);
    return pxDiff * state.qty * multiplier();
  }
  function recalcPnL(pxUnder, pxOpt){
    const mtm = markToMarket(pxUnder, pxOpt);
    elMTM.textContent = isNaN(mtm) ? '—' : mtm.toFixed(2);
    const total = state.realized + (isNaN(mtm) ? 0 : mtm);
    elPnL.textContent = total.toFixed(2);
    elPnL.className = (total >= 0) ? 'pnl-positive' : 'pnl-negative';
  }
  function refreshPositionUI(){
    elSide.textContent  = state.side;
    elQty.textContent   = state.qty;
    elEntry.textContent = (state.entry==null ? '—' : state.entry.toFixed(2));
  }

  // Eventos de órdenes
  document.getElementById('px-source').addEventListener('change', (e) => { state.source = e.target.value; });
  document.getElementById('qty').addEventListener('change', (e) => { state.qty = parseInt(e.target.value || '0', 10); refreshPositionUI(); });

  document.getElementById('btnBuy').addEventListener('click', () => {
    if (!CH10) return;
    const pxU = CH10.close[idx-1];
    const pxO = (CHOPT && XO.length) ? (() => { const k=nearestIndex(XO, X10[idx-1]); return k>=0?CHOPT.close[k]:null; })() : null;
    state.side = 'LONG'; state.entry = assetPrice(pxU, pxO);
    refreshPositionUI(); recalcPnL(pxU, pxO);
  });
  document.getElementById('btnSell').addEventListener('click', () => {
    if (!CH10) return;
    const pxU = CH10.close[idx-1];
    const pxO = (CHOPT && XO.length) ? (() => { const k=nearestIndex(XO, X10[idx-1]); return k>=0?CHOPT.close[k]:null; })() : null;
    state.side = 'SHORT'; state.entry = assetPrice(pxU, pxO);
    refreshPositionUI(); recalcPnL(pxU, pxO);
  });
  document.getElementById('btnFlat').addEventListener('click', () => {
    if (!CH10) return;
    const pxU = CH10.close[idx-1];
    const pxO = (CHOPT && XO.length) ? (() => { const k=nearestIndex(XO, X10[idx-1]); return k>=0?CHOPT.close[k]:null; })() : null;
    state.realized += markToMarket(pxU, pxO);
    state.side = 'FLAT'; state.entry = null;
    refreshPositionUI(); recalcPnL(pxU, pxO);
  });

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

  // Arranque
  updateFrame(1);
});
