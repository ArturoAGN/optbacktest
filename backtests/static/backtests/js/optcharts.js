/*  optcharts.js — sin gaps; 30m live; 1D con histórico+live (100)
    - 10m: sin histórico (idxStart→idx).
    - 30m: live desde 10m (sin histórico).
    - 1D : histórico (servidor) + live desde 10m; look-back 100 velas.
    - Ocultos: 20:00–04:00 y fines de semana (SÁB y DOM) sin ocultar el lunes.
*/
(() => {
  const PAPER = '#0f172a', GRID = '#334155', AXIS = '#94a3b8', FG = '#e5e7eb';
  const PLOT_CFG = { responsive:true, scrollZoom:true, displaylogo:false, displayModeBar:true,
    modeBarButtonsToRemove:['select2d','lasso2d','autoScale2d'] };

  const LOOKBACK_1D = 100;

  const toMs = s => new Date(s).getTime();
  const bisectRight = (arr, x) => { let lo=0, hi=arr.length; while (lo<hi){ const m=(lo+hi)>>>1; if (arr[m] <= x) lo=m+1; else hi=m; } return lo-1; };
  const ymd = s => { const d=new Date(s); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

  // 04:00–20:00 visibles; oculto 20:00–04:00
  function prepareIntraday(S) {
    if (!S) return null;
    const out = { title:S.title||'', x:[], open:[], high:[], low:[], close:[], volume:(S.volume?[]:[]) };
    for (let i=0;i<(S.x||[]).length;i++){
      const d = new Date(S.x[i]);
      const h = d.getHours() + d.getMinutes()/60;
      if (h >= 20 || h < 4) continue;
      out.x.push(S.x[i]);
      out.open.push(S.open[i]); out.high.push(S.high[i]); out.low.push(S.low[i]); out.close.push(S.close[i]);
      if (S.volume) out.volume.push(S.volume[i]);
    }
    return out;
  }

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

  function buildDailyFrom10m(src, uptoIdx, fromIdx){
    const out={x:[],open:[],high:[],low:[],close:[],volume:[],title:''};
    if(!src?.x?.length) return out;
    const start=Math.max(1,fromIdx||1), limit=Math.min(Math.max(start,uptoIdx||1), src.x.length);
    if (limit < start) return out;

    let curDay=null, o=0,h=0,l=0,c=0,v=0, xs=null;
    for(let i=start-1;i<limit;i++){
      const key = ymd(src.x[i]);
      if (curDay===null || key!==curDay){
        if (curDay!==null){
          out.x.push(xs); out.open.push(o); out.high.push(h); out.low.push(l); out.close.push(c); out.volume.push(v);
        }
        curDay = key;
        xs = `${key}T16:00`;
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

  function mergeDailyHistory(hist, live, maxN){
    if ((!hist||!hist.x) && (!live||!live.x)) return {x:[],open:[],high:[],low:[],close:[],volume:[],title:'1 día (live)'};
    const H = hist && hist.x ? {...hist} : {x:[],open:[],high:[],low:[],close:[],volume:[]};
    const L = live && live.x ? live : {x:[],open:[],high:[],low:[],close:[],volume:[]};
    const firstL = L.x.length ? ymd(L.x[0]) : null;
    const out = {x:[],open:[],high:[],low:[],close:[],volume:[],title: (live?.title || hist?.title || '1 día (live)')};

    for (let i=0;i<(H.x||[]).length;i++){
      const day = ymd(H.x[i]);
      if (firstL && day >= firstL) break;
      out.x.push(H.x[i]); out.open.push(H.open[i]); out.high.push(H.high[i]); out.low.push(H.low[i]); out.close.push(H.close[i]); out.volume.push(H.volume[i]);
    }
    for (let i=0;i<(L.x||[]).length;i++){
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

  // >>> CAMBIO CLAVE: fines de semana en dos bloques (Sáb y Dom) + noches 20:00–04:00
  function baseLayout(title){
    return {
      paper_bgcolor:PAPER, plot_bgcolor:PAPER,
      title:{text:title||'', font:{color:FG, size:12}},
      margin:{l:48,r:12,t:26,b:24},
      dragmode:'pan',
      uirevision:'keep',
      hovermode:'x unified',
      xaxis:{
        type:'date', color:AXIS, gridcolor:GRID, rangeslider:{visible:false}, zeroline:false,
        rangebreaks: [
          { pattern: 'day of week', bounds: [6, 7] }, // sábado completo
          { pattern: 'day of week', bounds: [0, 1] }, // domingo completo
          { pattern: 'hour',       bounds: [20, 4] }  // noches
        ]
      },
      yaxis:{domain:[0.22, 1.0], color:AXIS, gridcolor:GRID, zeroline:false},
      yaxis2:{domain:[0.00, 0.18], color:AXIS, gridcolor:GRID, showticklabels:false, zeroline:false}
    };
  }

  const LAYOUTS = { m10:null, m30:null, d1:null };
  const REV = { m10:0, m30:0, d1:0 };

  function drawOrReact(divId, series, key, title){
    if(!LAYOUTS[key]) LAYOUTS[key] = baseLayout(title || series.title || '');
    const layout = LAYOUTS[key];
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
    const CH10R = CH10 ? prepareIntraday(CH10) : null;  // 04:00–20:00
    const D1H   = context.ch1d_hist || null;            // histórico 1D (servidor)

    if(!CH10R?.x?.length){
      Plotly.purge('chart_10m'); Plotly.purge('chart_30m'); Plotly.purge('chart_1d');
      return { advance:()=>{}, setToStart:()=>{} };
    }

    const X10 = CH10R.x.map(toMs);
    let idxStart = 1;
    if (context.play_from){
      const i = bisectRight(X10, toMs(context.play_from)) + 1;
      idxStart = Math.max(1, Math.min(i, CH10R.x.length));
    }
    let idx = idxStart;

    // Inicial
    drawOrReact('chart_10m', sliceSeries(CH10R, idxStart, idxStart), 'm10', CH10R.title);
    const s30_init = buildAggFrom10m(CH10R, 30, idxStart, idxStart);
    drawOrReact('chart_30m', s30_init, 'm30', s30_init.title);

    const d1_live_init = buildDailyFrom10m(CH10R, idxStart, idxStart);
    const d1_merged_init = mergeDailyHistory(D1H, d1_live_init, LOOKBACK_1D);
    drawOrReact('chart_1d', d1_merged_init, 'd1', d1_merged_init.title);

    // Avance
    function advance(step){
      idx = Math.max(idxStart, Math.min(CH10R.x.length, idx + step));
      drawOrReact('chart_10m', sliceSeries(CH10R, idxStart, idx), 'm10');

      const s30 = buildAggFrom10m(CH10R, 30, idx, idxStart);
      drawOrReact('chart_30m', s30, 'm30');

      const d1_live = buildDailyFrom10m(CH10R, idx, idxStart);
      const d1_merged = mergeDailyHistory(D1H, d1_live, LOOKBACK_1D);
      drawOrReact('chart_1d', d1_merged, 'd1');
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
