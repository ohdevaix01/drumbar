// Verifica que el detector distinga objetos de verdad.
// Sintetiza golpes con resonancias fisicamente distintas y ruidos que NO son
// golpes, y mide cuantos acierta y cuantos rechaza.
const fs = require("fs");
const vm = require("vm");

let registered = null;
const ctx = {
  sampleRate: 48000,
  currentTime: 0,
  console, Math, Float32Array, Array, Object, Int16Array,
  registerProcessor: (n, c) => { registered = { name: n, cls: c }; },
  AudioWorkletProcessor: class {
    constructor() { this.port = { postMessage: () => {}, onmessage: null }; }
  },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + "/detector-worklet.js", "utf8"), ctx);

let T = 0;
Object.defineProperty(ctx, "currentTime", { get: () => T, configurable: true });

const SR = 48000;

/* ---------- sintesis de objetos ---------- */
// Un objeto golpeado = suma de modos resonantes con decaimiento propio.
// distinto material/tamano => distintos modos y distintos tiempos de caida.
const OBJECTS = {
  // madera grande y hueca: modos graves, resuena bastante
  caja: { modes: [[180, 1.0], [340, 0.6], [520, 0.35]], decay: 0.30, noise: 0.15 },
  // metal fino: modos agudos inarmonicos, decae lento
  lata: { modes: [[1900, 1.0], [3100, 0.8], [4700, 0.6]], decay: 0.45, noise: 0.25 },
  // plastico: modos medios, decae rapido
  bidon: { modes: [[620, 1.0], [980, 0.7], [1450, 0.4]], decay: 0.12, noise: 0.20 },
  // vidrio: muy agudo y largo
  vaso: { modes: [[3200, 1.0], [5100, 0.7], [7000, 0.5]], decay: 0.55, noise: 0.10 },
};

function synthHit(def, dur, seed) {
  const n = Math.floor(SR * dur);
  const out = new Float32Array(n);
  let s = seed || 1;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff * 2 - 1; };
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (const [f, amp] of def.modes) {
      v += Math.sin(2 * Math.PI * f * t) * amp * Math.exp(-t / def.decay);
    }
    // ruido del ataque (el click del impacto)
    v += rnd() * def.noise * Math.exp(-t / 0.004);
    out[i] = v * 0.18;
  }
  return out;
}

// Ruidos que NO son golpes: no deben disparar nada
function synthNoise(kind, dur, seed) {
  const n = Math.floor(SR * dur);
  const out = new Float32Array(n);
  let s = seed || 1;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff * 2 - 1; };
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (kind === "voz") {
      // voz: armonicos con vibrato, sostenido
      const f0 = 130 + Math.sin(2 * Math.PI * 4 * t) * 8;
      out[i] = (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(2 * Math.PI * f0 * 2 * t)) * 0.10;
    } else if (kind === "siseo") {
      // ruido de fondo constante
      out[i] = rnd() * 0.02;
    } else if (kind === "click") {
      // click seco de 3 ms: cortisimo, no resuena
      out[i] = t < 0.003 ? rnd() * 0.35 : 0;
    } else if (kind === "roce") {
      // roce continuo de banda ancha
      out[i] = rnd() * 0.06;
    }
  }
  return out;
}

/* ---------- correr audio por el detector ---------- */
function run(det, samples, blockSize) {
  const bs = blockSize || 128;
  for (let i = 0; i < samples.length; i += bs) {
    const chunk = samples.subarray(i, Math.min(i + bs, samples.length));
    const padded = new Float32Array(bs);
    padded.set(chunk);
    T += bs / SR;
    det.process([[padded]]);
  }
}

function makeDet() {
  const det = new registered.cls({ processorOptions: { thr: 3.5 } });
  const events = [];
  det.port.postMessage = (m) => events.push(m);
  // calibrar con silencio
  T = 0;
  run(det, new Float32Array(SR * 0.4));
  return { det, events };
}

/* ---------- test ---------- */
let ok = 0, fail = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "OK   " : "FALLA"} ${name}${extra ? " :: " + extra : ""}`);
  cond ? ok++ : fail++;
}

// 1. cada objeto genera una huella estable entre golpes
const prints = {};
for (const [name, def] of Object.entries(OBJECTS)) {
  prints[name] = [];
  for (let k = 0; k < 6; k++) {
    const { det, events } = makeDet();
    const hit = synthHit(def, 0.6, 100 + k * 17);
    run(det, hit);
    run(det, new Float32Array(SR * 0.15));
    const ons = events.filter((e) => e.type === "onset");
    if (ons.length) prints[name].push(ons[0]);
  }
  check(`objeto "${name}" dispara`, prints[name].length >= 5, `${prints[name].length}/6 golpes`);
}

// 2. la huella del mismo objeto es consistente (variacion baja)
function dist(a, b) {
  let d = 0;
  for (let i = 0; i < a.bands.length; i++) { const x = a.bands[i] - b.bands[i]; d += x * x; }
  d = Math.sqrt(d / a.bands.length);
  return d + Math.abs(a.centroid - b.centroid) * 0.5 + Math.abs((a.decay || 0) - (b.decay || 0)) * 0.8;
}
function meanIntra(list) {
  let s = 0, n = 0;
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) { s += dist(list[i], list[j]); n++; }
  return n ? s / n : 0;
}
function meanInter(a, b) {
  let s = 0, n = 0;
  for (const x of a) for (const y of b) { s += dist(x, y); n++; }
  return n ? s / n : 0;
}

const names = Object.keys(OBJECTS);
const intra = {};
names.forEach((n) => { intra[n] = meanIntra(prints[n]); });

const intraMax = Math.max(...Object.values(intra));
console.log(`\n  variacion intra-objeto (mas alta): ${intraMax.toFixed(3)}`);
names.forEach((n) => console.log(`    ${n.padEnd(7)} ${intra[n].toFixed(3)}`));

// 3. objetos distintos deben estar MAS lejos entre si que la variacion propia
console.log("\n  separacion entre objetos distintos:");
let minInter = Infinity;
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const d = meanInter(prints[names[i]], prints[names[j]]);
    minInter = Math.min(minInter, d);
    const ratio = d / Math.max(intra[names[i]], intra[names[j]], 0.001);
    console.log(`    ${names[i].padEnd(7)} vs ${names[j].padEnd(7)} d=${d.toFixed(3)}  ratio=${ratio.toFixed(1)}x`);
  }
}
check("objetos distintos se separan bien", minInter > intraMax * 3,
  `min inter=${minInter.toFixed(3)} vs max intra=${intraMax.toFixed(3)}`);

// 4. clasificacion cruzada: cada golpe debe ir a su pad
function classify(ev, pads) {
  const K = 3;
  let best = -1, bestD = Infinity;
  pads.forEach((samples, i) => {
    const ds = samples.map((s) => dist(ev, s)).sort((a, b) => a - b);
    const k = Math.min(K, ds.length);
    let sum = 0;
    for (let j = 0; j < k; j++) sum += ds[j];
    const d = sum / k;
    if (d < bestD) { bestD = d; best = i; }
  });
  return { pad: best, d: bestD };
}

// aprender con 4 muestras, evaluar con las otras 2
let correct = 0, total = 0;
names.forEach((n, idx) => {
  const train = prints[n].slice(0, 4);
  const test = prints[n].slice(4);
  const pads = names.map((m) => (m === n ? train : prints[m].slice(0, 4)));
  test.forEach((ev) => {
    total++;
    const r = classify(ev, pads);
    if (r.pad === idx) correct++;
  });
});
const acc = correct / total;
check("clasificacion cruzada de objetos", acc >= 0.9, `${correct}/${total} = ${(acc * 100).toFixed(0)}%`);

// 5. ruidos que no son golpes NO deben clasificarse como un pad
console.log("\n  rechazo de ruidos que no son golpes:");
const pads = names.map((n) => prints[n].slice(0, 4));
const noiseTol = 0.35;
["voz", "siseo", "click", "roce"].forEach((kind) => {
  let rejected = 0, attempts = 0;
  for (let k = 0; k < 5; k++) {
    const { det, events } = makeDet();
    run(det, synthNoise(kind, 0.8, 200 + k * 13));
    run(det, new Float32Array(SR * 0.1));
    const ons = events.filter((e) => e.type === "onset");
    attempts++;
    if (!ons.length) { rejected++; continue; }  // ni siquiera disparo: mejor
    const r = classify(ons[0], pads);
    if (r.pad < 0 || r.d > noiseTol) rejected++;
  }
  check(`"${kind}" rechazado`, rejected === attempts, `${rejected}/${attempts}`);
});

console.log(`\n${ok} OK, ${fail} FALLA`);
process.exit(fail ? 1 : 0);
