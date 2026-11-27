// A small stand-in for the dashboard runtime the Claude version runs on.
// It loads the published sheet, runs the calculations in order and redraws
// every element marked with data-draw whenever the data or the range changes.
(() => {
  const config = window.SLEEP_TRACKER_CONFIG || {};
  const loaders = {};
  const calcs = [];
  const draws = new Map();
  const listeners = [];
  const state = {};

  const PARAM_KEY = 'sleep-tracker:params';
  const readParams = () => {
    const out = {range: '30'};
    try { Object.assign(out, JSON.parse(localStorage.getItem(PARAM_KEY) || '{}')); } catch (e) { /* storage blocked */ }
    const hash = new URLSearchParams(location.hash.slice(1));
    if (hash.get('range')) out.range = hash.get('range');
    return out;
  };
  let params = readParams();

  const dash = {
    loader(id, def) { loaders[id] = def; },
    calc(id, def) { calcs.push({id, ...def}); },
    draw(name, fn) { draws.set(name, fn); },
    data(id) { return state[id] || {status: 'loading'}; },
    params() { return {...params}; },
    setParams(next) {
      params = {...params, ...next};
      try { localStorage.setItem(PARAM_KEY, JSON.stringify(params)); } catch (e) { /* storage blocked */ }
      recompute();
    },
    onData(fn) { listeners.push(fn); },
  };
  window.dash = dash;

  function recompute() {
    for (const c of calcs) {
      const inputs = (c.inputs || []).map((id) => dash.data(id));
      if (inputs.some((d) => d.status === 'error')) state[c.id] = {status: 'error', error: inputs.find((d) => d.status === 'error').error};
      else if (inputs.some((d) => d.status !== 'ok')) state[c.id] = {status: 'loading'};
      else {
        try { state[c.id] = {status: 'ok', data: c.fn(...inputs.map((d) => d.data))}; }
        catch (e) { console.error(`[sleep-tracker] ${c.id}`, e); state[c.id] = {status: 'error', error: e}; }
      }
    }
    render();
  }

  function render() {
    for (const [name, fn] of draws) {
      document.querySelectorAll(`[data-draw="${name}"]`).forEach((el) => {
        try { fn(el); } catch (e) { console.error(`[sleep-tracker] draw ${name}`, e); }
      });
    }
    for (const fn of listeners) {
      try { fn(); } catch (e) { console.error('[sleep-tracker] onData', e); }
    }
  }

  let lastLoad = 0;
  async function load() {
    const url = config.csvUrl;
    lastLoad = Date.now();
    try {
      if (!url || /PASTE/.test(url)) throw new Error('No sheet link set in config.js.');
      const sep = url.includes('?') ? '&' : '?';
      const res = await fetch(`${url}${sep}t=${Date.now()}`, {cache: 'no-store'});
      if (!res.ok) throw new Error(`The sheet answered ${res.status}.`);
      const text = await res.text();
      if (/^\s*</.test(text)) throw new Error('The sheet link returned a web page, not CSV.');
      const grid = d3.csvParseRows(text);
      const out = loaders.sleep_log.fn({answer: {values: grid}});
      state.sleep_log = {status: 'ok', data: out.rows};
    } catch (e) {
      console.error('[sleep-tracker] load', e);
      // Keep showing the last good data if a later refresh fails.
      if (!state.sleep_log || state.sleep_log.status !== 'ok') state.sleep_log = {status: 'error', error: e};
    }
    recompute();
  }

  function start() {
    render();
    load();
    const every = Math.max(1, Number(config.refreshMinutes) || 5) * 60 * 1000;
    setInterval(load, every);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - lastLoad > 60 * 1000) load();
    });
    let timer = null;
    let lastWidth = window.innerWidth;
    window.addEventListener('resize', () => {
      if (window.innerWidth === lastWidth) return;
      lastWidth = window.innerWidth;
      clearTimeout(timer);
      timer = setTimeout(render, 150);
    });
  }
  // app.js registers everything first; start once the page has parsed.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else setTimeout(start, 0);
})();
