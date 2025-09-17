// backtest.js (versión con zoom persistente)
// Clave: cacheamos layouts por gráfico y solo actualizamos DATA.
// - uirevision: 'bt'  -> preserva interacciones del usuario (zoom/pan)
// - datarevision++    -> obliga a refrescar trazas sin tocar layout

document.addEventListener('DOMContentLoaded', () => {
  // ==== Helpers UI menores ====
  document.querySelectorAll('input[type="date"]').forEach(el => {
    el.addEventListener('click', () => { if (el.showPicker) el.showPicker(); });
    el.addEventListener('keydown', e => { if (e.key === 'Escape') el.value = ''; });
  });

  // ==== Tabs Órdenes / Trades ====
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
    activateTab('orders');
  }

  // ==== Contexto del backend ====
  const ctxEl = document.getElementById('bt-context');
  if (!ctxEl) return;
  let BT = {};
  try { BT = JSON.parse(ctxEl.textContent || '{}'); } catch (e) { BT = {}; }

  const CH10  = BT.ch10  || null;
  const CHOPT = BT.chopt || null;
  const RB_HOURS = BT.rb_hours || [20,4];

  const { baseLayout, tracesFrom } = window.OptCharts || {};
  const PLOT_CFG = window.PLOT_CFG || { responsive: true, scrollZoom: true };
  if (!baseLayout || !tracesFrom) { console.warn('OptCharts no cargado'); return; }

  // ==== Caches de layout (¡la clave para conservar zoom!) ====
  // Los construimos UNA sola vez y los reutilizamos en cada actualización.
  let L10 = null, L30 = null, L1D = null, LO = null;

  // datarevision por gráfico
  let rev10 = 0, rev30 = 0, rev1d = 0, revOpt = 0;

  // ==== Utilidades de series/agregación ====
  const toMillis = iso => new Date(iso).getTime();
  const fmt = (n,d=2) => (n==null||isNaN(n) ? '—' : Number(n).toFixed(d));
  const bisectRight = (arr, x) => { let lo=0, hi=arr.length; while(lo<hi){ const m=(lo+hi)>>>1; if(arr[m]<=x) lo=m+1; else hi=m; } return lo-1; };
  const X10 = CH10?.x ? CH10.x.map(toMillis) : [];
  const XO  = CHOPT?.x ? CHOPT.x.map(toMillis) : [];

  function baseNameFrom(title){ return (title||'Activo').split('·')[0].trim(); }

  function buildAggFrom10m(intervalMin, uptoIdx){
    const out = { x:[], open:[], high:[], low:[], close:[], volume:[], title:'' };
    if (!CH10?.x?.length) return out;
    const limit = Math.min(Math.max(1, uptoIdx), CH10.x.length);
    const BIN = intervalMin * 60000;
    let cur=null, xstr=null, o=0,h=0,l=0,c=0,v=0;
    for (let i=0; i<limit; i++){
      const ms = X10[i];
      const bin = Math.floor(ms / BIN) * BIN;
      if (cur===null || bin!==cur){
        if (cur!==null){ out.x.push(xstr); out.open.push(o); out.high.push(h); out.low.push(l); out.close.push(c); out.volume.push(v); }
        cur=bin; xstr=CH10.x[i];
        o=CH10.open[i]; h=CH10.high[i]; l=CH10.low[i]; c=CH10.close[i]; v=(CH10.volume?.[i]||0);
      } else {
        h=Math.max(h,CH10.high[i]); l=Math.min(l,CH10.low[i]); c=CH10.close[i]; v+=(CH10.volume?.[i]||0);
      }
    }
    if (cur!==null){ out.x.push(xstr); out.open.push(o); out.high.push(h); out.low.push(l); out.close.push(c); out.volume.push(v); }
    out.title = `${baseNameFrom(CH10.title)} · ${intervalMin} minutos (live)`;
    return out;
  }

  function buildDailyFrom10m(uptoIdx){
    const out = { x:[], open:[], high:[], low:[], close:[], volume:[], title:'' };
    if (!CH10?.x?.length) return out;
    const limit = Math.min(Math.max(1,uptoIdx), CH10.x.length);
    let cur=null, xstr=null, o=0,h=0,l=0,c=0,v=0;
    const dayKey = i => (CH10.x[i]||'').slice(0,10);
    for (let i=0;i<limit;i++){
      const dk = dayKey(i);
      if (cur===null || dk!==cur){
        if (cur!==null){ out.x.push(xstr); out.open.push(o); out.high.push(h); out.low.push(l); out.close.push(c); out.volume.push(v); }
        cur=dk; xstr=CH10.x[i];
        o=CH10.open[i]; h=CH10.high[i]; l=CH10.low[i]; c=CH10.close[i]; v=(CH10.volume?.[i]||0);
      } else {
        h=Math.max(h,CH10.high[i]); l=Math.min(l,CH10.low[i]); c=CH10.close[i]; v+=(CH10.volume?.[i]||0);
      }
    }
    if (cur!==null){ out.x.push(xstr); out.open.push(o); out.high.push(h); out.low.push(l); out.close.push(c); out.volume.push(v); }
    out.title = `${baseNameFrom(CH10.title)} · 1 día (live)`;
    return out;
  }

  // ==== Estado reproducción / órdenes (sin cambios) ====
  let idx = 1, timer = null, speed = 1;
  const BASE_MS = 600;

  const elTs=document.getElementById('bt-ts');
  const elPx=document.getElementById('bt-px');
  const elOpt=document.getElementById('bt-opt');
  const elPnL=document.getElementById('bt-pnl');
  const elSide=document.getElementById('pos-side');
  const elQty=document.getElementById('pos-qty');
  const elEntry=document.getElementById('pos-entry');
  const elMTM=document.getElementById('pos-mtm');

  const state={ pos:{qty:0, entry:null, source:'under'}, realized:0, params:{slip_bps:0, comm_fixed:0, comm_perunit:0} };
  const orders=[], trades=[];
  const multiplier = s => s==='option'?100:1;

  function applySlippage(px,side,bps){ const m=(bps||0)/10000; if(side==='BUY') return px*(1+m); if(side==='SELL') return px*(1-m); return px; }
  function commissionTotal(qty,src,p){ return (p.comm_perunit||0)*Math.abs(qty)*multiplier(src) + (p.comm_fixed||0); }
  function markToMarket(last){ if(state.pos.qty===0||state.pos.entry==null) return 0; const d=(state.pos.qty>0)?(last-state.pos.entry):(state.pos.entry-last); return d*Math.abs(state.pos.qty)*multiplier(state.pos.source); }
  function refreshPositionUI(){ const side=state.pos.qty===0?'FLAT':(state.pos.qty>0?'LONG':'SHORT'); elSide.textContent=side; elQty.textContent=state.pos.qty; elEntry.textContent=(state.pos.entry==null?'—':state.pos.entry.toFixed(2)); }
  function recalcPnL(pxU,pxO){ const last=(state.pos.source==='option'&&pxO!=null)?pxO:pxU; const mtm=last==null?0:markToMarket(last); elMTM.textContent=isNaN(mtm)?'—':mtm.toFixed(2); const total=state.realized+(isNaN(mtm)?0:mtm); elPnL.textContent=total.toFixed(2); elPnL.className=(total>=0)?'pnl-positive':'pnl-negative'; return {mtm,total}; }

  function recordTrade(q,entry,exit){ const id=orders.length+trades.length+1; const side=(q>0)?'LONG':'SHORT'; const qty=Math.abs(q); const pnl=(side==='LONG')?(exit-entry):(entry-exit); trades.push({id,side,qty,entry_ts:elTs.textContent||'',entry_px:entry,exit_ts:elTs.textContent||'',exit_px:exit,pnl:pnl*qty*multiplier(state.pos.source)}); renderTrades(); }
  function realizeClose(q,px){ const per=(state.pos.qty>0)?(px-state.pos.entry):(state.pos.entry-px); state.realized+=per*Math.abs(q)*multiplier(state.pos.source); }
  function consumeFillIntoPosition(side,qty,px,src,comm){
    state.realized-=(comm||0);
    if(state.pos.qty===0){ state.pos={qty,entry:px,source:src}; return; }
    if(state.pos.source!==src){ realizeClose(state.pos.qty,px); recordTrade(state.pos.qty,state.pos.entry,px); state.pos={qty,entry:px,source:src}; return; }
    const newQty=state.pos.qty+qty;
    if((state.pos.qty>0&&newQty>0)||(state.pos.qty<0&&newQty<0)){
      const oa=Math.abs(state.pos.qty), aa=Math.abs(qty), na=Math.abs(newQty);
      state.pos.entry=((state.pos.entry*oa)+(px*aa))/na; state.pos.qty=newQty; return;
    }
    const closing=Math.min(Math.abs(state.pos.qty),Math.abs(qty));
    const closedSameSign=(state.pos.qty>0)?closing:-closing;
    realizeClose(closedSameSign,px); recordTrade(closedSameSign,state.pos.entry,px);
    const rem=state.pos.qty+qty;
    if(rem===0){ state.pos.qty=0; state.pos.entry=null; } else { state.pos.qty=rem; state.pos.entry=px; state.pos.source=src; }
  }

  const elOrdersBody=document.getElementById('orders-body');
  const elTradesBody=document.getElementById('trades-body');
  function renderOrders(){ if(!elOrdersBody) return; elOrdersBody.innerHTML=''; for(const o of orders){ const tr=document.createElement('tr'); tr.innerHTML=`<td>${o.id}</td><td>${o.ts||''}</td><td>${o.side}</td><td>${o.type}</td><td>${o.price==null?'—':o.price.toFixed(2)}</td><td>${o.qty}</td><td>${o.source}</td><td>${o.status}</td><td>${o.fill_ts||'—'}</td><td>${o.fill_px==null?'—':o.fill_px.toFixed(2)}</td><td>${o.status==='OPEN'?`<button data-cancel="${o.id}" class="secondary">Cancelar</button>`:'—'}</td>`; elOrdersBody.appendChild(tr);} elOrdersBody.querySelectorAll('button[data-cancel]').forEach(b=>b.addEventListener('click',e=>{ const id=parseInt(e.currentTarget.getAttribute('data-cancel'),10); const o=orders.find(x=>x.id===id); if(o&&o.status==='OPEN'){o.status='CANCELLED'; renderOrders();}})); }
  function renderTrades(){ if(!elTradesBody) return; elTradesBody.innerHTML=''; for(const t of trades){ const tr=document.createElement('tr'); tr.innerHTML=`<td>${t.id}</td><td>${t.side}</td><td>${t.qty}</td><td>${t.entry_ts}</td><td>${t.entry_px.toFixed(2)}</td><td>${t.exit_ts}</td><td>${t.exit_px.toFixed(2)}</td><td>${t.pnl.toFixed(2)}</td>`; elTradesBody.appendChild(tr);} }

  function placeOrder(side,type,price,qty,src,tif){
    const id=(orders.length+trades.length)+1;
    const ts=CH10?CH10.x[Math.max(0,idx-1)] : '';
    orders.push({id,ts,side,type,price:(type==='MKT'?null:Number(price||0)),qty:Number(qty),source:src,tif,status:'OPEN',fill_ts:null,fill_px:null});
    renderOrders();
  }
  function tryFillOrderOnBar(o,bar){
    if(o.status!=='OPEN') return false;
    if(o.type==='MKT'){ const px=applySlippage(bar.c,o.side,state.params.slip_bps); const com=commissionTotal(o.qty,o.source,state.params); doFill(o,bar.t,px,com); return true; }
    if(o.type==='LMT'){
      if(o.side==='BUY' && bar.l<=o.price){ const eff=(bar.o<=o.price)?bar.o:o.price; const px=applySlippage(eff,o.side,state.params.slip_bps); doFill(o,bar.t,px,commissionTotal(o.qty,o.source,state.params)); return true; }
      if(o.side==='SELL'&& bar.h>=o.price){ const eff=(bar.o>=o.price)?bar.o:o.price; const px=applySlippage(eff,o.side,state.params.slip_bps); doFill(o,bar.t,px,commissionTotal(o.qty,o.source,state.params)); return true; }
    }
    if(o.type==='STP'){
      if(o.side==='BUY' && bar.h>=o.price){ const eff=(bar.o>=o.price)?bar.o:o.price; const px=applySlippage(eff,o.side,state.params.slip_bps); doFill(o,bar.t,px,commissionTotal(o.qty,o.source,state.params)); return true; }
      if(o.side==='SELL'&& bar.l<=o.price){ const eff=(bar.o<=o.price)?bar.o:o.price; const px=applySlippage(eff,o.side,state.params.slip_bps); doFill(o,bar.t,px,commissionTotal(o.qty,o.source,state.params)); return true; }
    }
    return false;
  }
  function doFill(o,ts,px,comm){ o.status='FILLED'; o.fill_ts=ts; o.fill_px=px; const q=(o.side==='BUY')?Math.abs(o.qty):-Math.abs(o.qty); consumeFillIntoPosition(o.side,q,px,o.source,comm); renderOrders(); }

  function getBar(source,i){
    if(source==='option' && CHOPT){ return { o:CHOPT.open[i], h:CHOPT.high[i], l:CHOPT.low[i], c:CHOPT.close[i], t:CHOPT.x[i] }; }
    return { o:CH10.open[i], h:CH10.high[i], l:CH10.low[i], c:CH10.close[i], t:CH10.x[i] };
  }
  function processOrdersOnCurrentBar(){
    if(!CH10?.x) return;
    const barU=getBar('under', idx-1);
    const barO=(CHOPT ? getBar('option', Math.min(idx-1, CHOPT.x.length-1)) : null);
    for(const o of orders){
      if(o.status!=='OPEN') continue;
      if(o.source==='under'){ tryFillOrderOnBar(o,barU); }
      else if(o.source==='option' && barO){ tryFillOrderOnBar(o,barO); }
    }
  }

  // ==== Render de OPCIÓN (usa layout cache LO) ====
  function renderOptionChart(uptoK){
    if(!CHOPT){ Plotly.purge('chart_opt'); return; }
    if(!LO){ LO = baseLayout(CHOPT.title || 'Opción', true, CHOPT, RB_HOURS); }
    const k = (uptoK==null)?1:Math.max(1,uptoK);
    const data = [
      { x:CHOPT.x.slice(0,k), open:CHOPT.open.slice(0,k), high:CHOPT.high.slice(0,k), low:CHOPT.low.slice(0,k), close:CHOPT.close.slice(0,k),
        type:'candlestick', name:'Precio', xaxis:'x', yaxis:'y' },
      { x:CHOPT.x.slice(0,k), y:CHOPT.volume.slice(0,k), type:'bar', name:'Volumen', xaxis:'x', yaxis:'y2', opacity:0.4 }
    ];
    LO.datarevision = ++revOpt;            // <-- solo data cambia
    Plotly.react('chart_opt', data, LO, PLOT_CFG);
  }

  // ==== Inicialización de layouts + primer pintado ====
  function initCharts(){
    if (CH10?.x?.length){
      // Creamos layouts una sola vez y los reutilizamos
      L10 = baseLayout(CH10.title, true, CH10, RB_HOURS);

      const dummyForShapes = { x: CH10.x }; // shapes/rangebreaks toman del vector x
      L30 = baseLayout(`${baseNameFrom(CH10.title)} · 30 minutos (live)`, true, dummyForShapes, RB_HOURS);
      L1D = baseLayout(`${baseNameFrom(CH10.title)} · 1 día (live)`, false, dummyForShapes, RB_HOURS);

      // Pintado inicial con 1 barra
      const T10 = tracesFrom(CH10, 1);
      L10.datarevision = ++rev10;
      Plotly.newPlot('chart_10m', T10, L10, PLOT_CFG);

      const AG30_0 = buildAggFrom10m(30, 1);
      L30.datarevision = ++rev30;
      Plotly.newPlot('chart_30m', tracesFrom(AG30_0, null), L30, PLOT_CFG);

      const AG1D_0 = buildDailyFrom10m(1);
      L1D.datarevision = ++rev1d;
      Plotly.newPlot('chart_1d', tracesFrom(AG1D_0, null), L1D, PLOT_CFG);
    } else {
      // Placeholders si no hay datos
      const blank = { x:[], open:[], high:[], low:[], close:[], volume:[], title:'' };
      L10 = baseLayout('10 minutos', true, blank, RB_HOURS);
      L30 = baseLayout('30 minutos (live)', true, blank, RB_HOURS);
      L1D = baseLayout('1 día (live)', false, blank, RB_HOURS);
      Plotly.newPlot('chart_10m', tracesFrom(blank,null), L10, PLOT_CFG);
      Plotly.newPlot('chart_30m', tracesFrom(blank,null), L30, PLOT_CFG);
      Plotly.newPlot('chart_1d',  tracesFrom(blank,null), L1D, PLOT_CFG);
    }

    if (CHOPT){ renderOptionChart(1); } else { Plotly.purge('chart_opt'); }
  }

  // ==== Reproducción sincronizada (usa layouts cacheados) ====
  function updateFrame(i){
    if (!CH10?.x?.length){ return; }
    idx = Math.max(1, Math.min(i, CH10.x.length));
    const tIso = CH10.x[idx-1];
    const tMs  = toMillis(tIso);

    // 10m
    L10.datarevision = ++rev10;
    Plotly.react('chart_10m', tracesFrom(CH10, idx), L10, PLOT_CFG);

    // 30m (live)
    const AG30 = buildAggFrom10m(30, idx);
    L30.datarevision = ++rev30;
    Plotly.react('chart_30m', tracesFrom(AG30, null), L30, PLOT_CFG);

    // 1D (live)
    const AG1D = buildDailyFrom10m(idx);
    L1D.datarevision = ++rev1d;
    Plotly.react('chart_1d', tracesFrom(AG1D, null), L1D, PLOT_CFG);

    // Opción sincronizada
    if (CHOPT){
      const k = Math.max(1, bisectRight(XO, tMs) + 1);
      renderOptionChart(k);
    }

    // Estado
    const pxU = CH10.close[idx-1];
    let pxO = null;
    if (CHOPT){
      const k = Math.max(1, bisectRight(XO, tMs) + 1);
      if (k>0) pxO = CHOPT.close[k-1];
    }
    elTs.textContent  = tIso || '—';
    elPx.textContent  = fmt(pxU);
    elOpt.textContent = fmt(pxO);

    // Órdenes + PnL
    processOrdersOnCurrentBar();
    recalcPnL(pxU, pxO);
    refreshPositionUI();
  }

  function play(){
    if (timer || !CH10?.x?.length) return;
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

  // ==== Controles ====
  document.getElementById('btnStart').addEventListener('click', () => { pause(); updateFrame(1); });
  document.getElementById('btnBack').addEventListener('click',  () => { pause(); updateFrame(Math.max(1, idx-1)); });
  document.getElementById('btnFwd').addEventListener('click',   () => { pause(); updateFrame(idx+1); });
  document.getElementById('btnPlay').addEventListener('click',  play);
  document.getElementById('btnPause').addEventListener('click', pause);
  document.getElementById('speed').addEventListener('change', (e) => {
    speed = parseFloat(e.target.value || '1');
    if (timer) { pause(); play(); }
  });

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
    if (el) el.addEventListener('change', () => {
      state.params.slip_bps     = parseFloat(document.getElementById('slip-bps').value || '0');
      state.params.comm_fixed   = parseFloat(document.getElementById('comm-fixed').value || '0');
      state.params.comm_perunit = parseFloat(document.getElementById('comm-perunit').value || '0');
    });
  });

  // Órdenes rápidas (MKT)
  document.getElementById('btnBuy').addEventListener('click', () => {
    const qty = parseInt(document.getElementById('qty').value||'0',10);
    const source = document.getElementById('px-source').value;
    if (!qty) return;
    placeOrder('BUY','MKT',null,qty,source,'DAY');
    processOrdersOnCurrentBar();
    const pxU = CH10?.close[Math.max(1, idx)-1];
    const k = CHOPT ? Math.max(0, bisectRight(XO, X10[Math.max(1, idx)-1])) : -1;
    const pxO = (CHOPT && k>=0) ? CHOPT.close[k] : null;
    recalcPnL(pxU, pxO); refreshPositionUI();
  });
  document.getElementById('btnSell').addEventListener('click', () => {
    const qty = parseInt(document.getElementById('qty').value||'0',10);
    const source = document.getElementById('px-source').value;
    if (!qty) return;
    placeOrder('SELL','MKT',null,qty,source,'DAY');
    processOrdersOnCurrentBar();
    const pxU = CH10?.close[Math.max(1, idx)-1];
    const k = CHOPT ? Math.max(0, bisectRight(XO, X10[Math.max(1, idx)-1])) : -1;
    const pxO = (CHOPT && k>=0) ? CHOPT.close[k] : null;
    recalcPnL(pxU, pxO); refreshPositionUI();
  });
  document.getElementById('btnFlat').addEventListener('click', () => {
    const q = state.pos.qty; if (!q) return;
    const src = state.pos.source || document.getElementById('px-source').value;
    const side = q>0 ? 'SELL' : 'BUY';
    placeOrder(side,'MKT',null,Math.abs(q),src,'DAY');
    processOrdersOnCurrentBar();
    const pxU = CH10?.close[Math.max(1, idx)-1];
    const k = CHOPT ? Math.max(0, bisectRight(XO, X10[Math.max(1, idx)-1])) : -1;
    const pxO = (CHOPT && k>=0) ? CHOPT.close[k] : null;
    recalcPnL(pxU, pxO); refreshPositionUI();
  });

  // ==== Go! ====
  initCharts();
  updateFrame(1);
});
