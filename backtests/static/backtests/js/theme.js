// theme.js — toggle de tema con persistencia y notificación
(function(){
  const KEY = 'theme'; // 'light' | 'dark'
  const html = document.documentElement;
  const btn = () => document.getElementById('btnTheme');

  function apply(theme){
    html.setAttribute('data-theme', theme);
    const b = btn();
    if (b) b.textContent = (theme === 'dark') ? '☀️ Light' : '🌙 Dark';
    // Notificar a la app para re-tematizar gráficos
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
  }

  function current(){
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    // fallback: preferencia del sistema
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function toggle(){
    const next = (current() === 'dark') ? 'light' : 'dark';
    localStorage.setItem(KEY, next);
    apply(next);
  }

  // Init
  document.addEventListener('DOMContentLoaded', () => {
    apply(current());
    const b = btn();
    if (b) b.addEventListener('click', toggle);
  });
})();
