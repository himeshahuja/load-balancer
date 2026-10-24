// A load balancer in front of a pool of servers, as a discrete-event simulation
// in virtual milliseconds. Every request arrives, is routed, waits in a server's
// queue, is served by a worker and returns, or fails: dropped by a full queue,
// timed out on a dead server, or refused when no server is healthy.
import { MinHeap } from './heap.js';

const NET = 10; // ms each way between the balancer and a server
const TIMEOUT = 600; // ms before the balancer gives up on a silent server
const HEALTH_EVERY = 500; // ms between health checks
const UNHEALTHY_AFTER = 2; // failed checks before a server is taken out
const BASE_SERVICE = 60; // ms mean service time on a normal server
const SIGMA = 0.5; // spread of service times (lognormal)
const WINDOW = 10_000; // ms of history behind the live stats
const CLIENTS = 40;

export const ALGORITHMS = {
  roundRobin: {
    name: 'Round robin',
    desc: 'Each server in turn, regardless of how busy it is. Simple and even, until one server is slower than the rest.',
  },
  random: {
    name: 'Random',
    desc: 'A server picked at random. Even on average, but a busy server keeps getting its share.',
  },
  leastConn: {
    name: 'Least connections',
    desc: 'The server with the fewest requests in flight. Slow servers hold on to requests longer, so they get fewer.',
  },
  p2c: {
    name: 'Power of two choices',
    desc: 'Pick two servers at random and use the less busy one. Nearly as good as least connections without checking every server.',
  },
  ewma: {
    name: 'Least response time',
    desc: 'Prefers servers that have been answering quickly lately, weighted by how many requests they already hold.',
  },
  hashing: {
    name: 'Consistent hashing',
    desc: 'Each client always goes to the same server, so caches stay warm. When a server leaves, only its clients move.',
  },
};

// Seeded randomness so a comparison replays exactly the same traffic.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function percentile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export class Sim {
  constructor({ seed = 1, rps = 180, algo = 'roundRobin', servers } = {}) {
    this.rng = mulberry32(seed);
    this.trafficRng = mulberry32(seed * 7919 + 13); // arrivals, independent of routing choices
    this.now = 0;
    this.rps = rps;
    this.algo = algo;
    this.events = new MinHeap();
    this.seq = 0;
    this.log = [];
    this.done = []; // { t, lat }
    this.failed = []; // { t, why }
    this.series = []; // { t, p95 }
    this.listeners = new Set();
    this.rr = 0;
    this.servers = [];
    for (const s of servers ?? [{ speed: 1 }, { speed: 1 }, { speed: 1 }, { speed: 1 }, { speed: 2.5 }]) this.addServer(s.speed, true);
    this.rebuildRing();
    this.nextArrival = this.gap();
    this.nextHealth = HEALTH_EVERY;
    this.nextSample = 500;
  }

  // --- Setup ------------------------------------------------------------------------

  addServer(speed = 1, silent = false) {
    const s = {
      name: `server-${this.servers.length + 1}`,
      speed, // service time multiplier: 2.5 means 2.5× slower
      workers: 4,
      cap: 24, // queue slots
      busy: 0,
      queue: [],
      up: true,
      healthy: true,
      misses: 0,
      active: 0, // requests the balancer has sent and not heard back about
      ewma: BASE_SERVICE * speed,
      served: 0,
    };
    this.servers.push(s);
    if (!silent) {
      this.note(`${s.name} joined the pool`);
      this.rebuildRing();
    }
    return s;
  }

  removeServer() {
    if (this.servers.length <= 2) return;
    const s = this.servers[this.servers.length - 1];
    s.removed = true;
    this.crash(s, true);
    this.servers.pop();
    this.rebuildRing();
    this.note(`${s.name} left the pool`);
  }

  note(text, kind = 'info') {
    this.log.unshift({ t: this.now, text, kind });
    if (this.log.length > 50) this.log.pop();
  }

  on(fn) { this.listeners.add(fn); }
  emit(type, data) { for (const fn of this.listeners) fn(type, data); }

  gap() {
    return this.rps > 0 ? -Math.log(1 - this.trafficRng()) * (1000 / this.rps) : Infinity;
  }

  serviceTime(server) {
    // Lognormal around the mean, Box–Muller for the normal draw.
    const u = 1 - this.rng(), v = this.rng();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const mu = Math.log(BASE_SERVICE) - (SIGMA * SIGMA) / 2;
    return Math.exp(mu + SIGMA * z) * server.speed;
  }

  // --- Routing -------------------------------------------------------------------------

  candidates() {
    return this.servers.filter((s) => s.healthy);
  }

  rebuildRing() {
    this.ring = [];
    for (const s of this.candidates()) {
      for (let v = 0; v < 40; v++) this.ring.push({ h: hash(`${s.name}#${v}`), s });
    }
    this.ring.sort((a, b) => a.h - b.h);
  }

  pick(client) {
    const c = this.candidates();
    if (!c.length) return null;
    const leastBusy = (list) => {
      let best = list[0];
      for (const s of list) if (s.active < best.active || (s.active === best.active && this.rng() < 0.5)) best = s;
      return best;
    };
    switch (this.algo) {
      case 'random':
        return c[Math.floor(this.rng() * c.length)];
      case 'leastConn':
        return leastBusy(c);
      case 'p2c': {
        if (c.length === 1) return c[0];
        const a = Math.floor(this.rng() * c.length);
        let b = Math.floor(this.rng() * (c.length - 1));
        if (b >= a) b++;
        return c[a].active <= c[b].active ? c[a] : c[b];
      }
      case 'ewma': {
        let best = null, score = Infinity;
        for (const s of c) {
          const v = s.ewma * (s.active + 1);
          if (v < score) { score = v; best = s; }
        }
        return best;
      }
      case 'hashing': {
        const h = hash(`client-${client}`);
        const hit = this.ring.find((r) => r.h >= h) ?? this.ring[0];
        return hit.s;
      }
      default:
        return c[this.rr++ % c.length];
    }
  }

  // --- Events -------------------------------------------------------------------------------

  push(t, type, data) {
    this.events.push({ t, type, ...data, seq: this.seq++ }, t + this.seq * 1e-9);
  }

  step(dt) {
    const until = this.now + dt;
    for (;;) {
      const tEvent = this.events.size ? this.events.peekPri() : Infinity;
      const t = Math.min(tEvent, this.nextArrival, this.nextHealth, this.nextSample);
      if (t > until) break;
      this.now = t;
      if (t === this.nextArrival) { this.arrive(); this.nextArrival = this.now + this.gap(); }
      else if (t === this.nextHealth) { this.healthCheck(); this.nextHealth += HEALTH_EVERY; }
      else if (t === this.nextSample) { this.sample(); this.nextSample += 500; }
      else this.handle(this.events.pop());
    }
    this.now = until;
  }

  arrive() {
    const client = Math.floor(CLIENTS * this.trafficRng() ** 1.6); // some clients are busier than others
    const req = { id: this.seq++, client, t0: this.now };
    const s = this.pick(client);
    if (!s) {
      this.fail(req, 'no healthy servers');
      this.emit('refused', { req });
      return;
    }
    req.server = s;
    s.active++;
    this.emit('routed', { req, server: s });
    this.push(this.now + NET, 'reach', { req });
  }

  handle(ev) {
    const { req } = ev;
    const s = req.server;
    if (ev.type === 'reach') {
      if (!s.up || s.removed) { this.push(req.t0 + TIMEOUT, 'timeout', { req }); return; }
      if (s.busy < s.workers) this.start(s, req);
      else if (s.queue.length < s.cap) s.queue.push(req);
      else this.push(this.now + NET, 'reply', { req, ok: false, why: 'queue full (503)' });
    } else if (ev.type === 'finish') {
      if (req.lost) return; // the server crashed mid-request
      s.busy--;
      s.served++;
      const spent = this.now - req.startedAt + (req.startedAt - req.queuedAt);
      s.ewma = 0.85 * s.ewma + 0.15 * spent;
      this.push(this.now + NET, 'reply', { req, ok: true });
      const next = s.queue.shift();
      if (next) this.start(s, next);
    } else if (ev.type === 'reply') {
      s.active--;
      if (ev.ok) {
        this.done.push({ t: this.now, lat: this.now - req.t0 });
        this.emit('done', { req });
      } else {
        this.fail(req, ev.why);
        this.emit('failed', { req, server: s, why: ev.why });
      }
    } else if (ev.type === 'timeout') {
      s.active--;
      this.fail(req, 'timed out');
      this.emit('failed', { req, server: s, why: 'timed out' });
    }
  }

  start(s, req) {
    s.busy++;
    req.queuedAt = req.queuedAt ?? this.now;
    req.startedAt = this.now;
    if (req.queuedAt > this.now) req.queuedAt = this.now;
    this.push(this.now + this.serviceTime(s), 'finish', { req });
  }

  fail(req, why) {
    this.failed.push({ t: this.now, why });
  }

  healthCheck() {
    let changed = false;
    for (const s of this.servers) {
      if (s.up) {
        s.misses = 0;
        if (!s.healthy) { s.healthy = true; changed = true; this.note(`${s.name} passed its health check and is back in rotation`, 'ok'); }
      } else if (s.healthy && ++s.misses >= UNHEALTHY_AFTER) {
        s.healthy = false;
        changed = true;
        this.note(`${s.name} failed ${UNHEALTHY_AFTER} health checks and was taken out of rotation`, 'warn');
      }
    }
    if (changed) this.rebuildRing();
  }

  sample() {
    const from = this.now - WINDOW;
    while (this.done.length && this.done[0].t < from) this.done.shift();
    while (this.failed.length && this.failed[0].t < from) this.failed.shift();
    const recent = this.done.filter((d) => d.t >= this.now - 2000).map((d) => d.lat).sort((a, b) => a - b);
    this.series.push({ t: this.now, p95: percentile(recent, 0.95) });
    if (this.series.length > 80) this.series.shift();
  }

  // --- Stats and actions -------------------------------------------------------------------------

  stats() {
    const lat = this.done.map((d) => d.lat).sort((a, b) => a - b);
    const span = Math.min(WINDOW, this.now) / 1000 || 1;
    return {
      p50: percentile(lat, 0.5),
      p95: percentile(lat, 0.95),
      p99: percentile(lat, 0.99),
      throughput: this.done.length / span,
      errors: this.failed.length / span,
      errorRate: this.failed.length / Math.max(1, this.failed.length + this.done.length),
    };
  }

  setAlgo(algo) {
    this.algo = algo;
    this.note(`Switched to ${ALGORITHMS[algo].name.toLowerCase()}`);
  }

  crash(s, silent = false) {
    if (!s.up) return;
    s.up = false;
    // Requests on the dead server are lost; the balancer only learns by timing out.
    for (const req of [...s.queue]) this.push(Math.max(this.now, req.t0 + TIMEOUT), 'timeout', { req });
    s.queue = [];
    this.lostInFlight(s);
    s.busy = 0;
    if (!silent) this.note(`${s.name} crashed`, 'warn');
  }

  lostInFlight(s) {
    // Requests being served when the server died never finish; time them out.
    const pending = [];
    while (this.events.size) pending.push(this.events.pop());
    for (const ev of pending) {
      if (ev.type === 'finish' && ev.req.server === s) {
        ev.req.lost = true;
        this.push(Math.max(this.now, ev.req.t0 + TIMEOUT), 'timeout', { req: ev.req });
      } else {
        this.events.push(ev, ev.t + ev.seq * 1e-9);
      }
    }
  }

  recover(s) {
    s.up = true;
    this.note(`${s.name} came back up`, 'ok');
  }

  setSlow(s, slow) {
    s.speed = slow ? 3 : 1;
    this.note(slow ? `${s.name} slowed down to 3× service time` : `${s.name} back to normal speed`, slow ? 'warn' : 'ok');
  }
}

// Replays the same seeded traffic through every algorithm.
export function compareAll({ rps, servers, seconds = 40, seed = 42 }) {
  return Object.keys(ALGORITHMS).map((algo) => {
    const sim = new Sim({ seed, rps, algo, servers });
    sim.step(5000); // warm up
    const done = [];
    let failed = 0;
    const startT = sim.now;
    sim.on((type, data) => {
      if (sim.now < startT) return;
      if (type === 'done') done.push(sim.now - data.req.t0);
      if (type === 'failed' || type === 'refused') failed++;
    });
    sim.step(seconds * 1000);
    done.sort((a, b) => a - b);
    return {
      algo,
      p50: percentile(done, 0.5),
      p99: percentile(done, 0.99),
      errorRate: failed / Math.max(1, failed + done.length),
      served: done.length,
    };
  });
}
