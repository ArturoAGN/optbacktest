// charts.js - utilidades de gráficos (Plotly) con soporte de tema

(function () {
  function cssVar(name){
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function baseLayout(title, isIntraday, payload, rbHours) {
    const rb = isIntraday
      ? [{ pattern: 'day of week', bounds: [6, 1] }, { pattern: 'hour', bounds: rbHours }]
      : [{ pattern: 'day of week', bounds: [6, 1] }];

    const pmFill = cssVar('--pm-fill') || 'rgba(59,130,246,0.10)';
    const ahFill = cssVar('--ah-fill') || 'rgba(16,185,129,0.12)';
    const shapes = [];
    if (isIntraday && payload && payload.ext) {
      payload.ext.forEach(w => {
        shapes.push({
          type: 'rect', xref: 'x', yref: 'paper',
          x0: w.start, x1: w.end, y0: 0, y1: 1,
          fillcolor: (w.kind === 'pm') ? pmFill : ahFill,
          line: { width: 0 }, layer: 'below'
        });
      });
    }

    const paper = cssVar('--bg-panel') || '#ffffff';
    const plot  = cssVar('--bg-panel') || '#ffffff';
    const grid  = cssVar('--grid')     || '#e2e8f0';
    const fg    = cssVar('--fg')       || '#0f172a';

    return {
      title,
      dragmode: 'zoom',
      margin: { l: 40, r: 20, t: 28, b: 28 },
      paper_bgcolor: paper,
      plot_bgcolor: plot,
      font: { color: fg },
      xaxis: {
        type: 'date',
        rangeslider: { visible: false },
        gridcolor: grid,
        linecolor: grid,
        zerolinecolor: grid
      },
      yaxis: {
        title: 'Precio',
        domain: [0.30, 1.0],
        gridcolor: grid,
        linecolor: grid,
        zerolinecolor: grid
      },
      yaxis2: {
        title: 'Volumen',
        domain: [0.0, 0.25],
        gridcolor: grid,
        linecolor: grid,
        zerolinecolor: grid
      },
      legend: { orientation: 'h', x: 0, y: 1.08 },
      shapes
    };
  }

  function tracesFrom(payload, upto) {
    const k = (upto == null) ? payload.x.length : Math.max(1, upto);
    return [
      {
        x: payload.x.slice(0, k),
        open: payload.open.slice(0, k),
        high: payload.high.slice(0, k),
        low: payload.low.slice(0, k),
        close: payload.close.slice(0, k),
        type: 'candlestick',
        name: 'Precio',
        xaxis: 'x',
        yaxis: 'y1'
      },
      {
        x: payload.x.slice(0, k),
        y: payload.volume.slice(0, k),
        type: 'bar',
        name: 'Volumen',
        xaxis: 'x',
        yaxis: 'y2',
        opacity: 0.4
      }
    ];
  }

  window.OptCharts = { baseLayout, tracesFrom };
})();
