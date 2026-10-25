import { Sim, ALGORITHMS, compareAll } from './sim.js';

const SPEEDS = [0.1, 0.25, 0.5, 1, 2];
const MAX_SERVERS = 8;
const DOT_RATE = 14; // most request dots drawn per real second
const DOT_MS = 420; // how long a dot takes to reach its server
const $ = (id) => document.getElementById(id);

const view = $('view');
const ctx = view.getContext('2d');
const chart = $('chart');
const cctx = chart.getContext('2d');
const menu = $('menu');

let sim = new Sim({ rps: 180, algo: 'roundRobin' });
let running = true;
let speed = 0.25;
let colors = readColors();
let size = { w: 0, h: 0 };
let geo = { lb: null, cards: [] };
let dots = [];
let marks = []; // failure crosses
let menuServer = null;

// Until the visitor touches anything, a short demo plays on a loop.
let autopilot = true;
const DEMO = [
  { at: 7000, run: () => setAlgo('leastConn') },
  { at: 14000, run: () => sim.crash(sim.servers[1]) },
  { at: 20000, run: () => sim.recover(sim.servers[1]) },
  { at: 24000, run: () => setAlgo('p2c') },
  { at: 30000, run: () => setAlgo('roundRobin') },
];
const DEMO_LOOP = 32000;
let demoStep = 0;
let demoStart = 0;

function readColors() {
  const s = getComputedStyle(document.documentElement);
  const v = (n) => s.getPropertyValue(n).trim();
  return {
    ground: v('--ground'), surface: v('--surface'), raised: v('--raised'), border: v('--border'),
    ink: v('--ink'), muted: v('--muted'), faint: v('--faint'), accent: v('--accent'), queue: v('--api'), down: v('--down'),
  };
}

function wire() {
  sim.on((type, d) => {
    if (type === 'routed' && Math.random() < Math.min(1, DOT_RATE / Math.max(1, sim.rps * speed))) {
      dots.push({ server: d.server.name, t0: sim.now });
    } else if (type === 'failed') {
      marks.push({ server: d.server.name, t0: sim.now });
    } else if (type === 'refused' && Math.random() < 0.3) {
      marks.push({ server: null, t0: sim.now });
    }
  });
}

function setAlgo(algo) {
  sim.setAlgo(algo);
  $('algo').value = algo;
  $('algo-desc').textContent = ALGORITHMS[algo].desc;
  renderResults();
}

const takeOver = () => { autopilot = false; };

// Server speeds are service time multipliers: 2 takes twice as long, 0.5 half as long.
const SERVER_SPEEDS = [0.25, 1 / 3, 0.5, 2 / 3, 1, 1.5, 2, 2.5, 3, 4, 5];
const times = (n) => Number(n.toFixed(1));
const speedLabel = (v) => (v > 1 ? `${times(v)}× slower` : v < 1 ? `${times(1 / v)}× faster` : '');
const speedIndex = (v) => SERVER_SPEEDS.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(SERVER_SPEEDS[best] - v) ? i : best), 0);

// --- Geometry -----------------------------------------------------------------------

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (const [c, cx] of [[view, ctx], [chart, cctx]]) {
    const r = c.getBoundingClientRect();
    c.width = Math.round(r.width * dpr);
    c.height = Math.round(r.height * dpr);
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const r = view.getBoundingClientRect();
  size = { w: r.width, h: r.height };
}

function layout() {
  const { w, h } = size;
  const pad = 20;
  const narrow = w < 640;
  const lb = narrow
    ? { x: pad, y: pad, w: w - pad * 2, h: 64 }
    : { x: Math.max(pad + 90, w * 0.2), y: h / 2 - 52, w: 180, h: 92 };
  const x0 = narrow ? pad : lb.x + lb.w + Math.max(80, w * 0.1);
  const top = narrow ? lb.y + lb.h + 70 : pad;
  const bottom = h - 46;
  const n = sim.servers.length;
  const gap = 10;
  const ch = Math.min(92, (bottom - top - gap * (n - 1)) / n);
  const y0 = narrow ? top : (h - 30 - (ch * n + gap * (n - 1))) / 2;
  const cards = sim.servers.map((s, i) => ({ s, x: x0, y: y0 + i * (ch + gap), w: w - pad - x0, h: ch }));
  return { lb, cards, pad };
}

const rr = (x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };

// --- Drawing --------------------------------------------------------------------------------

function draw() {
  const { w, h } = size;
  const c = colors;
  ctx.clearRect(0, 0, w, h);
  geo = layout();
  const { lb } = geo;
  const now = sim.now;

  // Incoming traffic.
  ctx.fillStyle = c.muted;
  ctx.font = '500 12px "Inter Tight", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  if (lb.x > 120) {
    ctx.fillText('Clients', geo.pad, lb.y + lb.h / 2 - 8);
    ctx.fillStyle = c.ink;
    ctx.font = '700 15px "Bricolage Grotesque", "Inter Tight", sans-serif';
    ctx.fillText(`${sim.rps} req/s`, geo.pad, lb.y + lb.h / 2 + 12);
  }
  const streamFrom = lb.x > 120 ? geo.pad + 70 : lb.x;
  const flow = sim.rps ? Math.min(14, 3 + sim.rps / 25) : 0;
  for (let i = 0; i < flow; i++) {
    const p = ((now / 700 + i / flow) % 1);
    const x = streamFrom + (lb.x - streamFrom) * p;
    ctx.globalAlpha = Math.sin(p * Math.PI);
    ctx.fillStyle = c.ink;
    ctx.beginPath();
    ctx.arc(x, lb.y + lb.h / 2 + Math.sin(i * 2.4) * 10, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // The balancer.
  rr(lb.x, lb.y, lb.w, lb.h, 10);
  ctx.fillStyle = c.raised;
  ctx.fill();
  ctx.strokeStyle = c.accent;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = c.ink;
  ctx.font = '700 16px "Bricolage Grotesque", "Inter Tight", sans-serif';
  ctx.fillText('Load balancer', lb.x + 16, lb.y + 32);
  ctx.fillStyle = c.accent;
  ctx.font = '600 13px "Inter Tight", sans-serif';
  ctx.fillText(ALGORITHMS[sim.algo].name, lb.x + 16, lb.y + 54);
  if (lb.h > 80) {
    const healthy = sim.servers.filter((s) => s.healthy).length;
    ctx.fillStyle = c.muted;
    ctx.font = '500 12px "Inter Tight", sans-serif';
    ctx.fillText(`${healthy} of ${sim.servers.length} servers in rotation`, lb.x + 16, lb.y + 76);
  }

  // Servers.
  for (const card of geo.cards) {
    const { s, x, y } = card;
    const cw = card.w, chh = card.h;
    rr(x, y, cw, chh, 8);
    ctx.fillStyle = c.surface;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = !s.up ? c.down : c.border;
    ctx.setLineDash(!s.up || !s.healthy ? [5, 4] : []);
    ctx.stroke();
    ctx.setLineDash([]);

    const mid = y + chh / 2;
    ctx.globalAlpha = s.up ? 1 : 0.55;
    ctx.fillStyle = c.ink;
    ctx.font = '700 15px "Bricolage Grotesque", "Inter Tight", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(s.name, x + 14, mid - 4);
    const status = !s.up ? (s.healthy ? 'not responding' : 'out of rotation') : !s.healthy ? 'rejoining' : speedLabel(s.speed) || 'healthy';
    ctx.fillStyle = !s.up ? c.down : s.speed !== 1 ? c.accent : c.muted;
    ctx.font = '500 12px "Inter Tight", sans-serif';
    ctx.fillText(status, x + 14, mid + 14);

    // Workers.
    const ws = Math.min(22, chh - 30, (cw * 0.42) / s.workers - 5);
    const wx = x + Math.min(160, cw * 0.32);
    for (let i = 0; i < s.workers; i++) {
      rr(wx + i * (ws + 5), mid - ws / 2, ws, ws, 4);
      if (i < s.busy) { ctx.fillStyle = c.accent; ctx.fill(); }
      else { ctx.strokeStyle = c.muted; ctx.lineWidth = 1.2; ctx.stroke(); }
    }

    // Queue.
    const qx = wx + s.workers * (ws + 5) + 18;
    const qw = cw - (qx - x) - 70;
    const per = Math.max(1, Math.floor(qw / 10));
    ctx.fillStyle = c.queue;
    for (let i = 0; i < s.queue.length; i++) {
      const col = i % per, row = Math.floor(i / per);
      if (row > 1) break;
      ctx.beginPath();
      ctx.arc(qx + col * 10 + 4, mid - 5 + row * 10, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!s.queue.length && s.up) {
      ctx.fillStyle = c.faint;
      ctx.font = '500 12px "Inter Tight", sans-serif';
      ctx.fillText('no queue', qx, mid + 4);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = s.queue.length >= s.cap ? c.down : c.muted;
    ctx.font = '600 12px "Inter Tight", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${s.queue.length}/${s.cap}`, x + cw - 14, mid + 4);
  }

  // Requests on their way from the balancer.
  const from = { x: lb.x + lb.w, y: lb.y + lb.h / 2 };
  dots = dots.filter((d) => now - d.t0 < DOT_MS);
  ctx.fillStyle = c.ink;
  for (const d of dots) {
    const card = geo.cards.find((cd) => cd.s.name === d.server);
    if (!card) continue;
    const to = { x: card.x, y: card.y + card.h / 2 };
    const p = (now - d.t0) / DOT_MS;
    const cx = (from.x + to.x) / 2;
    const x = (1 - p) ** 2 * from.x + 2 * (1 - p) * p * cx + p ** 2 * to.x;
    const y = (1 - p) ** 2 * from.y + 2 * (1 - p) * p * ((from.y + to.y) / 2) + p ** 2 * to.y;
    ctx.beginPath();
    ctx.arc(x, y, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }

  // Failures: a red cross at the server (or the balancer, if nothing was healthy).
  marks = marks.filter((m) => now - m.t0 < 600);
  ctx.strokeStyle = c.down;
  ctx.lineWidth = 2;
  for (const m of marks) {
    const card = m.server && geo.cards.find((cd) => cd.s.name === m.server);
    const at = card ? { x: card.x - 8, y: card.y + card.h / 2 } : { x: lb.x + lb.w + 14, y: lb.y + lb.h / 2 };
    const jitter = ((m.t0 * 7) % 20) - 10;
    ctx.globalAlpha = 1 - (now - m.t0) / 600;
    ctx.beginPath();
    ctx.moveTo(at.x - 4, at.y + jitter - 4); ctx.lineTo(at.x + 4, at.y + jitter + 4);
    ctx.moveTo(at.x + 4, at.y + jitter - 4); ctx.lineTo(at.x - 4, at.y + jitter + 4);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawChart() {
  const r = chart.getBoundingClientRect();
  const w = r.width, h = r.height;
  cctx.clearRect(0, 0, w, h);
  const pts = sim.series.filter((p) => p.p95 !== null);
  const max = Math.max(200, ...pts.map((p) => p.p95));
  const top = Math.ceil(max / 250) * 250;
  $('chart-max').textContent = `${top.toLocaleString()} ms`;
  cctx.strokeStyle = colors.border;
  cctx.lineWidth = 1;
  cctx.setLineDash([3, 4]);
  for (const f of [0, 0.5, 1]) {
    cctx.beginPath();
    cctx.moveTo(0, 2 + (h - 4) * f);
    cctx.lineTo(w, 2 + (h - 4) * f);
    cctx.stroke();
  }
  cctx.setLineDash([]);
  if (pts.length < 2) return;
  const t1 = sim.now, t0 = t1 - 40000;
  cctx.beginPath();
  pts.forEach((p, i) => {
    const x = ((p.t - t0) / (t1 - t0)) * w;
    const y = h - 2 - (p.p95 / top) * (h - 4);
    i ? cctx.lineTo(x, y) : cctx.moveTo(x, y);
  });
  cctx.strokeStyle = colors.accent;
  cctx.lineWidth = 2;
  cctx.lineJoin = 'round';
  cctx.stroke();
}

// --- Panel ---------------------------------------------------------------------------------

const ms = (v) => (v == null ? '–' : `${Math.round(v).toLocaleString()} ms`);
let lastResults = null;

function renderPanel() {
  const st = sim.stats();
  $('s-p50').textContent = ms(st.p50);
  $('s-p99').textContent = ms(st.p99);
  $('s-served').textContent = `${Math.round(st.throughput)}/s`;
  $('s-failed').textContent = `${Math.round(st.errors)}/s`;
  $('s-failed').style.color = st.errors >= 1 ? 'var(--down)' : '';
  $('add').disabled = sim.servers.length >= MAX_SERVERS;
  $('remove').disabled = sim.servers.length <= 2;

  const fmt = (t) => `${(t / 1000).toFixed(1)}s`;
  const html = sim.log.slice(0, 30).map((e) => `
    <li class="${e.kind === 'warn' ? 'warn' : ''}"><time>${fmt(e.t)}</time><span class="msg">${e.text}</span></li>`).join('');
  const feed = $('feed');
  if (feed.dataset.html !== html) { feed.innerHTML = html; feed.dataset.html = html; }
}

function renderResults() {
  const table = $('results');
  if (!lastResults) { table.hidden = true; return; }
  table.hidden = false;
  const bestP99 = Math.min(...lastResults.map((r) => r.p99 ?? Infinity));
  table.querySelector('tbody').innerHTML = lastResults.map((r) => `
    <tr data-algo="${r.algo}" class="${r.algo === sim.algo ? 'is-current' : ''}">
      <td>${ALGORITHMS[r.algo].name}</td>
      <td>${ms(r.p50)}</td>
      <td class="${r.p99 === bestP99 ? 'best' : ''}">${ms(r.p99)}</td>
      <td class="${r.errorRate > 0.005 ? 'bad' : ''}">${(r.errorRate * 100).toFixed(1)}%</td>
    </tr>`).join('');
}

// --- Controls -----------------------------------------------------------------------------

for (const [key, a] of Object.entries(ALGORITHMS)) $('algo').add(new Option(a.name, key));
$('algo').value = sim.algo;
$('algo-desc').textContent = ALGORITHMS[sim.algo].desc;
$('algo').addEventListener('change', (e) => { takeOver(); setAlgo(e.target.value); });

$('rps').addEventListener('input', (e) => {
  takeOver();
  sim.rps = Number(e.target.value);
  sim.nextArrival = sim.now + sim.gap();
  $('rps-val').textContent = `${sim.rps} req/s`;
});

$('compare').addEventListener('click', () => {
  takeOver();
  const btn = $('compare');
  btn.disabled = true;
  btn.textContent = 'Comparing…';
  // Let the label paint before the (synchronous) runs.
  setTimeout(() => {
    lastResults = compareAll({ rps: sim.rps, servers: sim.servers.map((s) => ({ speed: s.speed, workers: s.workers })) });
    btn.disabled = false;
    btn.textContent = 'Compare all';
    renderResults();
  }, 30);
});
$('results').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-algo]');
  if (!row) return;
  takeOver();
  setAlgo(row.dataset.algo);
});

$('add').addEventListener('click', () => { takeOver(); if (sim.servers.length < MAX_SERVERS) sim.addServer({ speed: SERVER_SPEEDS[Number($('new-speed').value)], workers: Number($('new-workers').value) }); });
$('remove').addEventListener('click', () => { takeOver(); sim.removeServer(); });
$('play').addEventListener('click', () => { running = !running; $('play').textContent = running ? 'Pause' : 'Play'; });
$('new-speed').addEventListener('input', (e) => {
  $('new-speed-val').textContent = speedLabel(SERVER_SPEEDS[Number(e.target.value)]) || 'normal';
});
$('menu-speed').addEventListener('input', (e) => {
  if (!menuServer) return;
  const v = SERVER_SPEEDS[Number(e.target.value)];
  const label = speedLabel(v) || 'normal';
  $('menu-speed-val').textContent = label;
  sim.setSpeed(menuServer, v, label === 'normal' ? 'at normal speed' : label);
  renderPanel();
});
$('speed').addEventListener('input', (e) => {
  speed = SPEEDS[Number(e.target.value)];
  $('speed-val').textContent = `${speed}×`;
});

// --- Server menu ------------------------------------------------------------------------------

function openMenu(s, x, y) {
  menuServer = s;
  $('menu-title').textContent = s.name;
  const power = menu.querySelector('button');
  power.textContent = s.up ? 'Crash' : 'Bring back up';
  $('menu-speed').value = speedIndex(s.speed);
  $('menu-speed-val').textContent = speedLabel(s.speed) || 'normal';
  menu.hidden = false;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = `${Math.min(size.w - mw - 8, Math.max(8, x))}px`;
  menu.style.top = `${Math.min(size.h - mh - 8, Math.max(8, y))}px`;
}
function closeMenu() { menu.hidden = true; menuServer = null; }

view.addEventListener('click', (e) => {
  const r = view.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const card = geo.cards.find((cd) => x >= cd.x && x <= cd.x + cd.w && y >= cd.y && y <= cd.y + cd.h);
  if (!card) return closeMenu();
  takeOver();
  openMenu(card.s, x + 8, y + 8);
});
menu.addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (!act || !menuServer) return;
  if (act === 'power') (menuServer.up ? sim.crash(menuServer) : sim.recover(menuServer));
  closeMenu();
  renderPanel();
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());
document.addEventListener('pointerdown', (e) => {
  if (!menu.hidden && !menu.contains(e.target) && e.target !== view) closeMenu();
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { colors = readColors(); });

// --- Loop -------------------------------------------------------------------------------------

let last = performance.now();
let panelAt = 0;

function frame(t) {
  const dt = Math.max(0, Math.min(64, t - last));
  last = t;
  if (running) {
    sim.step(dt * speed);
    if (autopilot) {
      const into = sim.now - demoStart;
      while (demoStep < DEMO.length && into >= DEMO[demoStep].at) DEMO[demoStep++].run();
      if (into >= DEMO_LOOP) { demoStep = 0; demoStart = sim.now; }
    }
  }
  draw();
  if (t - panelAt > 200) { panelAt = t; renderPanel(); drawChart(); }
  requestAnimationFrame(frame);
}

wire();
new ResizeObserver(resize).observe(view);
new ResizeObserver(resize).observe(chart);
resize();
document.fonts.ready.then(() => { colors = readColors(); });
requestAnimationFrame(frame);
