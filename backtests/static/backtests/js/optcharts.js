/*  optcharts.js — sin grid ni leyenda; 30m live; 1D con histórico+live (100) + SOMBREADO SESIONES
    - 10m: sin histórico (idxStart→idx).
    - 30m: live desde 10m (sin histórico).
    - 1D : histórico (servidor) + live desde 10m; look-back 100 velas.
    - Intradía: oculta 20:00–04:00 y fines de semana + sombras pre/after.
    - 1D: NO oculta por horas (solo fines de semana) → no se “come” velas de las 00:00.
*/
(() => {
  const PAPER = '#0f172a', AXIS = '#94a3b8', FG = '#e5e7eb';
  const PLOT_CFG = { responsive:true, scrollZoom:true, displaylogo:false, displayModeBar:true,
    modeBarButtonsToRemove:['select2d','lasso2d','autoScale2d'] };

  const LOOKBACK_1D = 100;
  const TZ = 'America/New_York';

  const toMs = s => new Date(s).getTime();

  // YYYY-MM-DD en tz NY
  function ymdNY(s) {
    const d = new Date(s);
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    return fmt.format(d); // 'YYYY-MM-DD'
  }
  // HH:mm en tz NY
  function hmNY(s) {
    const d = new Date(s);
    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
    return fmt.format(d); // 'HH:mm'
  }
  // 04:00–20:00 visibles; oculto 20:00–04:00 (según NY)
  function isHiddenByNightNY(s) {
    const h = hmNY(s);
    return (h >= '20:00' || h < '04:00');
  }

  function prepareIntraday(S) {
    if (!S) return null;
    const out = { title:S.title||'', x:[], open:[], high:[], low:[], close:[], volume:(S.volume?[]:[]) };
    for (let i=0;i<(S.x||[]).length;i++){
      if (isHiddenByNightNY(S.x[i])) continue;
      out.x.push(S.x[i]);
      out.open.push(S.open[i]); out.high.push(S.high[i]); out.low.push(S.low[i]); out.close.push(S.close[i]);
      if (S.volume) out.volume.push(S.volume[i]);
    }
    return out;
  }

  // binning de 10m → N minutos
  function buildAggFrom10m(src, mins, uptoIdx, fromIdx){
    const out={x:[],open:[],high:[],low:[],close:[],volume:[],title:''};
    if(!src?.x?.length) return out;
    const start=Math.max(1,fromIdx||1), limit=Math.min(Math.max(start,uptoIdx||1), src.x.length);
    if (limit < start) return out;
    const BIN=mins*60000, X=src.x.map(toMs);
    let cur=null, xs=null, o=0,h=0,l=0,c=0,v=0;
    for(let i=start-1;i<limit;i++){
      const ms=X[i], bin=Math.floor(ms/BIN)*BIN;
      if(cur===null || bin!==cur){
        if(cur!==null){ out.x.push(xs); out.open.push(o); out.high.push(h); out.low.push(l); out.close.push(c); out.volume.push(v); }
        cur=bin; xs=src.x[i]; o=src.open[i]; h=src.high[i]; l=src.low[i]; c=src.close[i]; v=(src.volume?.[i]||0);
      }else{
        h=Math.max(h, src.high[i]); l=Math.min(l, src.low[i]); c=src.close[i]; v+=(src.volume?.[i]||0);
      }
    }
    if(cur!==null){ out.x.push(xs); out.open.push(o); out.high.push(h); out.low.push(l); out.close.push(c); out.volume.push(v); }
    const base = (src.title||'Activo').split('·')[0].trim();
    out.title = `${base} · ${mins} minutos (live)`;
    return out;
  }

  // 10m → 1D (día NY)
  function buildDailyFrom10m(src, uptoIdx, fromIdx){
    const out={x:[],open:[],high:[],low:[],close:[],volume:[],title:''};
    if(!src?.x?.length) return out;
    const start=Math.max(1,fromIdx||1), limit=Math.min(Math.max(start,uptoIdx||1), src.x.length);
    if (limit < start) return out;

    let curDay=null, o=0,h=0,l=0,c=0,v=0, xs=null;
    for(let i=start-1;i<limit;i++){
      const dayKey = ymdNY(src.x[i]);
      if (curDay===null || dayKey!==curDay){
        if (curDay!==null){
          out.x.push(xs); out.open.push(o); out.high.push(h); out.low.push(l); out.close.push(c); out.volume.push(v);
        }
        curDay = dayKey;
        // ponemos 16:00 para que no caiga en la franja oculta de noches (aunque en 1D no la aplicamos)
        xs = `${dayKey}T16:00`;
        o = src.open[i]; h = src.high[i]; l = src.low[i]; c = src.close[i]; v=(src.volume?.[i]||0);
      }else{
        h=Math.max(h, src.high[i]); l=Math.min(l, src.low[i]); c=src.close[i]; v+=(src.volume?.[i]||0);
      }
    }
    if (curDay!==null){
      out.x.push(xs); out.open.push(o); out.high.push(h); out.low.push(l); out.close.push(c); out.volume.push(v);
    }
    const base = (src.title||'Activo').split('·')[0].trim();
    out.title = `${base} · 1 día (live)`;
    return out;
  }

  // histórico 1D (servidor) + 1D live (desde 10m) con lookback
  function mergeDailyHistory(hist, live, maxN){
    const H = (hist && hist.x && hist.x.length) ? hist : {x:[],open:[],high:[],low:[],close:[],volume:[]};
    const L = (live && live.x && live.x.length) ? live : {x:[],open:[],high:[],low:[],close:[],volume:[]};

    if (!H.x.length && !L.x.length) return {x:[],open:[],high:[],low:[],close:[],volume:[],title:'1 día (live)'};

    const firstLiveDay = L.x.length ? ymdNY(L.x[0]) : null;
    const out = {x:[],open:[],high:[],low:[],close:[],volume:[],title: (live?.title || hist?.title || '1 día (live)')};

    for (let i=0;i<H.x.length;i++){
      const dH = ymdNY(H.x[i]);
      if (firstLiveDay && dH >= firstLiveDay) break;
      out.x.push(H.x[i]); out.open.push(H.open[i]); out.high.push(H.high[i]); out.low.push(H.low[i]); out.close.push(H.close[i]); out.volume.push(H.volume[i]);
    }
    for (let i=0;i<L.x.length;i++){
      out.x.push(L.x[i]); out.open.push(L.open[i]); out.high.push(L.high[i]); out.low.push(L.low[i]); out.close.push(L.close[i]); out.volume.push(L.volume[i]);
    }

    if (out.x.length > maxN){
      const cut = out.x.length - maxN;
      ['x','open','high','low','close','volume'].forEach(k => out[k] = out[k].slice(cut));
    }
    return out;
  }

  function sliceSeries(S,i1,i2){
    const a=Math.max(1,i1)-1, b=Math.max(a+1,Math.min(i2,(S?.x||[]).length));
    return { title:S.title, x:S.x.slice(a,b), open:S.open.slice(a,b), high:S.high.slice(a,b),
             low:S.low.slice(a,b), close:S.close.slice(a,b), volume:(S.volume||[]).slice(a,b) };
  }

  function tracesFrom(S){
    return [
      { x:S.x||[], open:S.open||[], high:S.high||[], low:S.low||[], close:S.close||[],
        type:'candlestick', name:'Precio', xaxis:'x', yaxis:'y',
        increasing:{line:{color:'#22c55e'}}, decreasing:{line:{color:'#ef4444'}} },
      { x:S.x||[], y:S.volume||[], type:'bar', name:'Volumen', xaxis:'x', yaxis:'y2', opacity:0.4 }
    ];
  }

  // layout base: modo 'intra' (10m/30m) vs 'daily' (1D)
  function baseLayout(title, mode){
    const rb = [
      { pattern: 'day of week', bounds: [6, 7] }, // sábado
      { pattern: 'day of week', bounds: [0, 1] }  // domingo
    ];
    if (mode === 'intra') {
      rb.push({ pattern: 'hour', bounds: [20, 4] }); // SOLO intradía: oculta noches
    }
    return {
      paper_bgcolor:PAPER, plot_bgcolor:PAPER,
      title:{text:title||'', font:{color:FG, size:12}},
      margin:{l:48,r:12,t:26,b:24},
      dragmode:'pan',
      uirevision:'keep',
      hovermode:'x unified',
      showlegend:false,
      xaxis:{
        type:'date', color:AXIS, rangeslider:{visible:false}, zeroline:false, showgrid:false,
        rangebreaks: rb
      },
      yaxis:{domain:[0.22, 1.0], color:AXIS, zeroline:false, showgrid:false},
      yaxis2:{domain:[0.00, 0.18], color:AXIS, showticklabels:false, zeroline:false, showgrid:false},
      shapes: []
    };
  }

  // ===== sombras pre/after por día (NY) — solo intradía =====
  function uniqueDaysFromSeriesNY(S){
    const set = new Set();
    (S?.x||[]).forEach(ts => set.add(ymdNY(ts)));
    return Array.from(set).sort();
  }
  function buildSessionShapes(days){
    const shapes = [];
    for(const d of days){
      shapes.push({ type:'rect', xref:'x', yref:'paper', x0:`${d}T04:00`, x1:`${d}T09:30`, y0:0, y1:1,
                    fillcolor:'rgba(56,189,248,0.10)', line:{width:0} });
      shapes.push({ type:'rect', xref:'x', yref:'paper', x0:`${d}T16:00`, x1:`${d}T20:00`, y0:0, y1:1,
                    fillcolor:'rgba(245,158,11,0.12)', line:{width:0} });
    }
    return shapes;
  }

  const LAYOUTS = { m10:null, m30:null, d1:null };
  const LAYOUT_MODE = { m10:'intra', m30:'intra', d1:'daily' };
  const REV = { m10:0, m30:0, d1:0 };

  function drawOrReact(divId, series, key, title, extraShapes){
    if(!LAYOUTS[key]) LAYOUTS[key] = baseLayout(title || series.title || '', LAYOUT_MODE[key]);
    const layout = LAYOUTS[key];
    if (Array.isArray(extraShapes)) layout.shapes = extraShapes; else layout.shapes = [];
    layout.datarevision = ++REV[key];
    const traces = tracesFrom(series);
    if(!window.__plotted) window.__plotted = {};
    if(!window.__plotted[divId]){
      window.__plotted[divId] = true;
      return Plotly.newPlot(divId, traces, layout, PLOT_CFG);
    }else{
      return Plotly.react(divId, traces, layout, PLOT_CFG);
    }
  }

  function initAndRun(context){
    const CH10  = context.ch10 || null;
    const CH10R = CH10 ? prepareIntraday(CH10) : null;
    // histórico 1D del servidor: acepta varias claves
    const D1H   = context.ch1d_hist || context.d1_hist || context.hist_1d || null;

    if(!CH10R?.x?.length){
      Plotly.purge('chart_10m'); Plotly.purge('chart_30m'); Plotly.purge('chart_1d');
      return { advance:()=>{}, setToStart:()=>{} };
    }

    const dayList = uniqueDaysFromSeriesNY(CH10R);
    const sessionShapes = buildSessionShapes(dayList);

    const X10 = CH10R.x.map(toMs);
    let idxStart = 1;
    if (context.play_from){
      const target = toMs(context.play_from);
      let lo=0, hi=X10.length;
      while(lo<hi){ const m=(lo+hi)>>>1; if (X10[m] <= target) lo=m+1; else hi=m; }
      idxStart = Math.max(1, Math.min(lo, CH10R.x.length));
    }
    let idx = idxStart;

    // inicial
    drawOrReact('chart_10m', sliceSeries(CH10R, idxStart, idxStart), 'm10', CH10R.title, sessionShapes);

    const s30_init = buildAggFrom10m(CH10R, 30, idxStart, idxStart);
    drawOrReact('chart_30m', s30_init, 'm30', s30_init.title, sessionShapes);

    const d1_live_init = buildDailyFrom10m(CH10R, idxStart, idxStart);
    const d1_merged_init = mergeDailyHistory(D1H, d1_live_init, LOOKBACK_1D);
    drawOrReact('chart_1d', d1_merged_init, 'd1', d1_merged_init.title, null);

    // avance
    function advance(step){
      idx = Math.max(idxStart, Math.min(CH10R.x.length, idx + step));

      drawOrReact('chart_10m', sliceSeries(CH10R, idxStart, idx), 'm10', null, sessionShapes);

      const s30 = buildAggFrom10m(CH10R, 30, idx, idxStart);
      drawOrReact('chart_30m', s30, 'm30', null, sessionShapes);

      const d1_live = buildDailyFrom10m(CH10R, idx, idxStart);
      const d1_merged = mergeDailyHistory(D1H, d1_live, LOOKBACK_1D);
      drawOrReact('chart_1d', d1_merged, 'd1', null, null);
    }

    return {
      advance,
      setToStart: () => { idx = idxStart; advance(0); },
      getIdx: () => idx,
      getIdxStart: () => idxStart
    };
  }

  window.OptLite = { initAndRun };
})();
