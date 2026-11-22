// Verifica que el detector distinga objetos reales y rechace ruidos.
//
// Genera objetos sinteticos con muchos modos resonantes (como un objeto de
// verdad), variando amplitud, afinacion, amortiguamiento y fase entre golpes:
// eso es lo que pasa al golpear distintos puntos del mismo objeto.
// Despues corre el worklet y el clasificador reales de la app.
//
// Uso: node test-discrim.js
const fs = require("fs");
const vm = require("vm");

const SR = 48000;

/* ---------------- objetos sinteticos ---------------- */

function makeObject(seed) {
  let s = seed;
  const r = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const modes = [];
  const f0 = 120 + r() * 200;
  const fmax = 3000 + r() * 6000;
  const n = 14 + Math.floor(r() * 10);
  for (let i = 0; i < n; i++) {
    const f = f0 * Math.pow(fmax / f0, i / (n - 1)) * (0.92 + r() * 0.16);
    modes.push([f, Math.pow(0.82, i) * (0.6 + r() * 0.8), 0.10 + r() * 0.45]);
  }
  return { modes, noise: 0.5 + r() * 0.6 };
}

function hit(obj, dur, seed, o) {
  o = o || {};
  const n = Math.floor(SR * dur);
  const out = new Float32Array(n);
  let s = seed || 1;
  const r = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff * 2 - 1; };
  const detune = 1 + (o.detune || 0);
  const off = o.off || 0;
  const amp = o.amp || 1;
  const damp = o.damp || 1;
  for (let i = 0; i < n; i++) {
    const t = (i + off) / SR;
    let v = 0;
    for (const [f, a, tau0] of obj.modes) {
      v += Math.sin(2 * Math.PI * f * detune * t + seed * 0.001) * a * Math.exp(-t / (tau0 * damp));
    }
    v += r() * obj.noise * Math.exp(-t / 0.005);
    out[i] = v * 0.10 * amp;
  }
  return out;
}

function noise(kind, dur, seed) {
  const n = Math.floor(SR * dur);
  const o = new Float32Array(n);
  let s = seed || 1;
  const r = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff * 2 - 1; };
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (kind === "voz") {
      const f0 = 130 + Math.sin(2 * Math.PI * 4 * t) * 8;
      o[i] = (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(2 * Math.PI * f0 * 2 * t)) * 0.10;
    } else if (kind === "siseo") {
      o[i] = r() * 0.02;
    } else if (kind === "click") {
      o[i] = t < 0.003 ? r() * 0.35 : 0;
    } else {
      o[i] = r() * 0.06;
    }
  }
  return o;
}

/* ---------------- carga del worklet y de la app ---------------- */

function loadWorklet() {
  let reg = null;
  const wc = {
    sampleRate: SR, currentTime: 0, console, Math, Float32Array, Array, Object,
    registerProcessor: (n, c) => { reg = { name: n, cls: c }; },
    AudioWorkletProcessor: class {
      constructor() { this.port = { postMessage: () => {}, onmessage: null }; }
    },
  };
  wc.globalThis = wc;
  vm.createContext(wc);
  vm.runInContext(fs.readFileSync(__dirname + "/detector-worklet.js", "utf8"), wc);
  let T = 0;
  Object.defineProperty(wc, "currentTime", { get: () => T, configurable: true });
  return { cls: reg.cls, setT: v => { T = v; }, getT: () => T };
}

function loadApp() {
  const html = fs.readFileSync(__dirname + "/index.html", "utf8");
  const parts = html.split("<script>");
  const el = {
    value: "3", checked: false, textContent: "", innerHTML: "",
    classList: { add() {}, remove() {} }, style: {}, children: [],
    insertBefore() {}, removeChild() {}, appendChild() {},
  };
  const ac = {
    console, Math, JSON, Array, Object, Int16Array, Uint8Array, Float32Array, Float64Array,
    ArrayBuffer, DataView, parseInt, parseFloat, isNaN, Date,
    performance: { now: () => 0 }, window: { addEventListener() {} },
    document: { getElementById: () => el, createElement: () => el, addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { mediaDevices: {} }, setTimeout: () => 0, setInterval: () => 0,
    MediaRecorder: function () {}, URL: { createObjectURL: () => "", revokeObjectURL() {} },
    lamejs: null,
  };
  ac.globalThis = ac;
  vm.createContext(ac);
  vm.runInContext(parts[parts.length - 1].split("</script>")[0], ac);
  return ac;
}

/* ---------------- corre el audio por el detector ---------------- */

function run(w, det, samples) {
  const bs = 128;
  for (let i = 0; i < samples.length; i += bs) {
    const c = samples.subarray(i, Math.min(i + bs, samples.length));
    const p = new Float32Array(bs);
    p.set(c);
    w.setT(w.getT() + bs / SR);
    det.process([[p]]);
  }
}

function detect(w, samples) {
  const det = new w.cls({ processorOptions: { thr: 3.5 } });
  const ev = [];
  det.port.postMessage = m => ev.push(m);
  w.setT(0);
  run(w, det, new Float32Array(SR * 0.4));
  w.setT(0);
  ev.length = 0;
  run(w, det, samples);
  run(w, det, new Float32Array(SR * 0.15));
  return ev.filter(e => e.type === "onset")[0] || null;
}

/* ---------------- test ---------------- */

let ok = 0, fail = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "OK   " : "FALLA"} ${name}${extra ? " :: " + extra : ""}`);
  cond ? ok++ : fail++;
}

const w = loadWorklet();
const app = loadApp();
const DIST = app.distance;

const OBJS = { A: makeObject(111), B: makeObject(222), C: makeObject(333), D: makeObject(444) };

let seed = 999;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const prints = {};
for (const [n, o] of Object.entries(OBJS)) {
  prints[n] = [];
  for (let k = 0; k < 10; k++) {
    const e = detect(w, hit(o, 0.6, 6000 + k * 137, {
      amp: 0.5 + rnd(),
      detune: (rnd() - 0.5) * 0.03,
      damp: 0.7 + rnd() * 0.7,
      off: rnd(),
    }));
    if (e) prints[n].push(e);
  }
}
const names = Object.keys(OBJS);

check("cada objeto dispara en casi todos los golpes",
  names.every(n => prints[n].length >= 9),
  names.map(n => n + ":" + prints[n].length + "/10").join(" "));

const first = prints[names[0]][0];
check("el evento trae las tres caracteristicas",
  first.bands && first.centroid !== undefined && first.decay !== undefined,
  "bandas=" + first.bands.length);

const intraMax = Math.max(...names.map(n => {
  let mx = 0;
  for (let i = 0; i < prints[n].length; i++)
    for (let j = i + 1; j < prints[n].length; j++)
      mx = Math.max(mx, DIST(prints[n][i], prints[n][j]));
  return mx;
}));
console.log(`\n  variacion propia del mismo objeto (la mas alta): ${intraMax.toFixed(2)}`);

app.S.pads = names.map(n => ({ name: n, def: n, samples: prints[n].slice(0, 5), buffer: null, el: null }));

let aciertos = 0, rechazados = 0, confundidos = 0, tot = 0;
for (let ci = 0; ci < names.length; ci++)
  for (const ev of prints[names[ci]].slice(5)) {
    tot++;
    const r = app.classify(ev);
    if (r.pad === ci) aciertos++;
    else if (r.pad < 0) rechazados++;
    else confundidos++;
  }

// Lo que no se tolera es disparar el pad equivocado. Rechazar es aceptable:
// no suena nada y el usuario golpea de nuevo. Confundir suena mal siempre.
check("cuando dispara, acierta el objeto", aciertos / (aciertos + confundidos) >= 0.95,
  `${aciertos}/${aciertos + confundidos} de los disparos fueron el pad correcto (rechazo ${rechazados}/${tot})`);

check("dispara la mayoria de los golpes", (aciertos + confundidos) / tot >= 0.6,
  `${aciertos + confundidos}/${tot} dispararon`);

check("casi nunca confunde un objeto con otro", confundidos / tot <= 0.08,
  confundidos + " confundidos de " + tot);

console.log("\n  rechazo de ruidos que no son golpes:");
let rj = 0, ntot = 0;
for (const kind of ["voz", "siseo", "click", "roce"])
  for (let k = 0; k < 5; k++) {
    ntot++;
    const e = detect(w, noise(kind, 0.8, 8000 + k * 53));
    if (!e) { rj++; continue; }
    if (app.classify(e).pad < 0) rj++;
  }

check("los ruidos no disparan pads", rj / ntot >= 0.95, `${rj}/${ntot}`);

// objetos que nunca se aprendieron: casi ninguno debe disparar un pad
let desconocidos = 0, desconocidosTot = 0;
for (let k = 0; k < 20; k++) {
  desconocidosTot++;
  const e = detect(w, hit(makeObject(9000 + k * 37), 0.6, 4242 + k, { amp: 0.7 + rnd() * 0.6 }));
  if (!e) { desconocidos++; continue; }
  if (app.classify(e).pad < 0) desconocidos++;
}
check("los objetos no aprendidos no disparan pads", desconocidos / desconocidosTot >= 0.9,
  `${desconocidos}/${desconocidosTot}`);

// --- el slider tiene que exigir MAS al subirlo (estuvo invertido una vez) ---
function appCon(val){
  const ac = loadApp();
  ac.document.getElementById = () => ({ value: String(val), checked:false, textContent:"", innerHTML:"",
    classList:{add(){},remove(){}}, style:{}, children:[], insertBefore(){}, removeChild(){}, appendChild(){} });
  return ac;
}
const padsRaros = names.map(n => ({ name:n, def:n, samples: prints[n].slice(0,5), buffer:null, el:null }));
function limiteCon(val){
  const ac = appCon(val);
  ac.S.pads = padsRaros.map(p => ({ name:p.name, def:p.def, samples:p.samples, buffer:null, el:null }));
  const r = ac.classify(prints[names[0]][5]);
  return r.limit;
}
const limPerm = limiteCon(1.5), limEstr = limiteCon(6);
check("subir la exigencia achica el limite", limEstr < limPerm,
  `exigencia 1.5 -> ${limPerm.toFixed(2)} | exigencia 6 -> ${limEstr.toFixed(2)}`);

// --- la distancia no puede ignorar bandas (estuvo desincronizada 10 vs 12) ---
const nBandas = first.bands.length;
const opuesto = { bands: first.bands.map(v => -v), centroid: first.centroid, decay: first.decay };
check("la distancia mira todas las bandas", DIST(first, opuesto) > 1,
  `${nBandas} bandas, distancia con el espectro invertido ${DIST(first, opuesto).toFixed(2)}`);

console.log(`\n${ok} OK, ${fail} FALLA`);
process.exit(fail ? 1 : 0);
