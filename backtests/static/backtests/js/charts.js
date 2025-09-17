// charts.js - utilidades de gráficos (Plotly)

(function () {
  function baseLayout(title, isIntraday, payload, rbHours) {
    const rb = isIntraday
      ? [{ pattern: 'day of week', bounds: [6, 1] }, { pattern: 'hour', bounds: rbHours }]
      : [{ pattern: 'day of week', bounds: [6, 1] }];

    const shapes = [];
    if (isIntraday && payload && payload.ext) {
      payload.ext.forEach(w => {
        shapes.push({
          type: 'rect', xref: 'x', yref: 'paper',
          x0: w.start, x1: w.end, y0: 0, y1: 1,
          fillcolor: (w.kind === 'pm') ? 'rgba(59,130,246,0.10)' : 'rgba(16,185,129,0.12)',
          line: { width: 0 }, layer: 'below'
        });
      });
    }

    return {
      title,
      dragmode: 'zoom',
      margin: { l: 40, r: 20, t: 28, b: 28 },
      xaxis: { type: 'date', rangeslider: { visible: false }, rangebreaks: rb },
      yaxis: { title: 'Precio', domain: [0.30, 1.0] },
      yaxis2: { title: 'Volumen', domain: [0.0, 0.25] },
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
