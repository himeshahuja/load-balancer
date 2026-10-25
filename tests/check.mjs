// Checks for the load balancer simulation. Run with: node tests/check.mjs
import { Sim, ALGORITHMS, compareAll } from '../js/sim.js';

let problems = 0;
const fail = (msg) => { problems++; if (problems <= 10) console.log('PROBLEM:', msg); };

// 1. Chaos: random crashes, recoveries, slowdowns, pool changes and traffic
//    swings, under every algorithm.
let requests = 0;
for (const algo of Object.keys(ALGORITHMS)) {
  for (let run = 0; run < 20; run++) {
    const sim = new Sim({ seed: run + 1, rps: 150, algo });
    let routed = 0, ended = 0;
    sim.on((type, d) => {
      if (type === 'routed') {
        routed++;
        if (!d.server.healthy) fail(`${algo}: routed to unhealthy ${d.server.name}`);
      }
      if (type === 'done' || type === 'failed') ended++;
    });
    for (let t = 0; t < 60_000; t += 20) {
      if (Math.random() < 0.004) {
        const s = sim.servers[(Math.random() * sim.servers.length) | 0];
        const r = Math.random();
        if (r < 0.35) (s.up ? sim.crash(s) : sim.recover(s));
        else if (r < 0.6) sim.setSpeed(s, [0.25, 0.5, 1, 2, 3, 5][(Math.random() * 6) | 0], 'changed');
        else if (r < 0.7 && sim.servers.length < 8) sim.addServer({ speed: [0.5, 1, 2.5, 4][(Math.random() * 4) | 0], workers: [2, 4, 8][(Math.random() * 3) | 0] });
        else if (r < 0.8) sim.removeServer();
        else sim.rps = Math.round(Math.random() * 400);
      }
      sim.step(20);
      for (const s of sim.servers) {
        if (s.busy > s.workers || s.busy < 0) fail(`${algo}: ${s.name} busy ${s.busy}`);
        if (s.queue.length > s.cap) fail(`${algo}: ${s.name} queue ${s.queue.length}`);
        if (s.active < 0) fail(`${algo}: ${s.name} active ${s.active}`);
      }
    }
    // Stop traffic, bring everything back, and let in-flight requests finish.
    sim.rps = 0;
    sim.nextArrival = Infinity;
    for (const s of sim.servers) if (!s.up) sim.recover(s);
    sim.step(10_000);
    requests += routed;
    if (routed !== ended) fail(`${algo} run ${run}: ${routed} routed but ${ended} ended`);
    for (const s of sim.servers) if (s.active !== 0) fail(`${algo}: ${s.name} still has ${s.active} in flight`);
  }
}
console.log(`chaos: ${requests.toLocaleString()} requests across ${Object.keys(ALGORITHMS).length} algorithms, ${problems} problems`);

// 2. Consistent hashing keeps each client on one server while the pool is stable.
{
  const sim = new Sim({ seed: 7, rps: 200, algo: 'hashing' });
  const home = new Map();
  let moved = 0;
  sim.on((type, d) => {
    if (type !== 'routed') return;
    const prev = home.get(d.req.client);
    if (prev && prev !== d.server) moved++;
    home.set(d.req.client, d.server);
  });
  sim.step(30_000);
  if (moved) fail(`hashing moved ${moved} requests while the pool was stable`);
  console.log(`hashing: ${home.size} clients, ${moved} requests moved off their server`);
}

// 3. With one slow server, the adaptive algorithms beat round robin on tail latency.
{
  const results = compareAll({ rps: 180, servers: [{ speed: 1 }, { speed: 1 }, { speed: 1 }, { speed: 1 }, { speed: 2.5 }] });
  const by = Object.fromEntries(results.map((r) => [r.algo, r]));
  for (const r of results) {
    console.log(`  ${ALGORITHMS[r.algo].name.padEnd(22)} p50 ${String(Math.round(r.p50)).padStart(4)} ms   p99 ${String(Math.round(r.p99)).padStart(5)} ms   errors ${(r.errorRate * 100).toFixed(2)}%`);
  }
  for (const smart of ['leastConn', 'p2c', 'ewma']) {
    if (!(by[smart].p99 < by.roundRobin.p99)) fail(`${smart} p99 not better than round robin`);
  }
}

console.log(problems ? `${problems} problems` : 'all checks passed');
process.exit(problems ? 1 : 0);
