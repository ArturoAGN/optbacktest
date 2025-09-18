// backtest.js — bootstrap de UI para OptLite
document.addEventListener('DOMContentLoaded', () => {
  const ctxEl = document.getElementById('bt-context');
  let BT = {};
  try { BT = JSON.parse(ctxEl?.textContent || '{}'); } catch {}

  const engine = window.OptLite.initAndRun(BT);

  const q = () => {
    const t  = (document.getElementById('ticker-input')?.value || 'AAPL').trim().toUpperCase();
    const sd = (document.getElementById('start-date')?.value || '').trim();
    const ed = (document.getElementById('end-date')?.value || '').trim();
    const p = new URLSearchParams(); if (t) p.set('ticker',t); if (sd) p.set('start',sd); if (ed) p.set('end',ed);
    window.location.assign(window.location.pathname + '?' + p.toString());
  };

  document.getElementById('btnQuery')?.addEventListener('click', q);
  ['ticker-input','start-date','end-date'].forEach(id=>{
    const el=document.getElementById(id);
    if (el) el.addEventListener('keydown', e=>{ if (e.key==='Enter') q(); });
  });

  const btnStart = document.getElementById('btnStart');
  const btnBack  = document.getElementById('btnBack');
  const btnFwd   = document.getElementById('btnFwd');
  const btnPlay  = document.getElementById('btnPlay');
  const btnPause = document.getElementById('btnPause');
  const speedSel = document.getElementById('speed');

  let timer=null;
  function pause(){ if(timer){ clearInterval(timer); timer=null; } if(btnPlay) btnPlay.disabled=false; if(btnPause) btnPause.disabled=true; }
  function play(){ if(timer) return; if(btnPlay) btnPlay.disabled=true; if(btnPause) btnPause.disabled=false;
    const sp = parseFloat(speedSel?.value||'1'); timer=setInterval(()=>engine.advance(1), 600/sp); }

  btnStart && btnStart.addEventListener('click', ()=>{ pause(); engine.setToStart(); });
  btnBack  && btnBack.addEventListener('click',  ()=>{ pause(); engine.advance(-1); });
  btnFwd   && btnFwd.addEventListener('click',   ()=>{ pause(); engine.advance(+1); });
  btnPlay  && btnPlay.addEventListener('click',  play);
  btnPause && btnPause.addEventListener('click', pause);
  speedSel && speedSel.addEventListener('change', ()=>{ if(timer){ pause(); play(); } });
});
