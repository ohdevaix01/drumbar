const fs = require("fs");
const html = fs.readFileSync(__dirname + "/index.html", "utf8");
let js = html.split("<script>")[1].split("</script>")[0];

function mkEl() {
  return {
    value: "3.5",
    textContent: "",
    innerHTML: "",
    classList: { add() {}, remove() {} },
    style: {},
    children: [],
    insertBefore() {},
    removeChild() {},
    appendChild() {},
    onclick: null,
    oninput: null,
    onchange: null,
  };
}
global.window = { addEventListener() {} };
global.document = {
  getElementById: () => mkEl(),
  createElement: () => mkEl(),
  addEventListener() {},
};
global.localStorage = { getItem: () => null, setItem() {} };
global.performance = { now: () => 0 };

js = js.replace('window.addEventListener("load", init);', "");
js = js.replace('"use strict";', "");
const vm = require("vm");
const ctx = vm.createContext({ window: global.window, document: global.document, localStorage: global.localStorage, performance: global.performance, console, Math, JSON, Array, Object, Float32Array, Float64Array, parseInt, parseFloat, setTimeout, setInterval });
vm.runInContext(js, ctx);
const fft = ctx.fft, bandEdges = ctx.bandEdges, distance = ctx.distance, classify = ctx.classify;
const S = ctx.S;

/* ---- 1. FFT: senoidal 1 kHz @ 48 kHz, N=1024 -> bin 21 ---- */
const N = 1024, sr = 48000;
const re = new Float64Array(N), im = new Float64Array(N);
for (let i = 0; i < N; i++) re[i] = Math.sin((2 * Math.PI * 1000 * i) / sr);
fft(re, im);
let peak = 0, pi = 0;
for (let i = 1; i < N / 2; i++) {
  const m = Math.hypot(re[i], im[i]);
  if (m > peak) { peak = m; pi = i; }
}
const fftHz = (pi * sr) / N;
console.log(`FFT: bin ${pi} -> ${fftHz.toFixed(0)} Hz (esperado ~1000)`);
console.log(fftHz > 900 && fftHz < 1100 ? "  OK" : "  FALLA");

/* ---- 2. bandEdges: monotonico y dentro de rango ---- */
const edges = bandEdges(48000, 1024);
let mono = true;
for (let i = 1; i < edges.length; i++) if (edges[i] <= edges[i - 1]) mono = false;
const inRange = edges[0] >= 0 && edges[edges.length - 1] <= 512;
console.log(`bandEdges: ${edges.join(",")}`);
console.log(mono && inRange ? "  OK (monotonico, en rango)" : "  FALLA");

/* ---- 3. distancia: misma huella = 0, opuestas = grande ---- */
const graves = { bands: [0.9, 0.05, 0.02, 0.01, 0.01, 0.01, 0, 0, 0, 0], centroid: 0.1 };
const agudos = { bands: [0.01, 0.02, 0.03, 0.05, 0.1, 0.15, 0.2, 0.2, 0.15, 0.09], centroid: 0.8 };
const dSame = distance(graves, graves);
const dDiff = distance(graves, agudos);
console.log(`distancia misma huella: ${dSame.toFixed(4)} (esperado 0)`);
console.log(`distancia grave vs agudo: ${dDiff.toFixed(4)} (esperado > 0.5)`);
console.log(dSame === 0 && dDiff > 0.5 ? "  OK" : "  FALLA");

/* ---- 4. distancia: variacion leve del mismo sonido debe ser chica ---- */
const graves2 = {
  bands: graves.bands.map((v, i) => v * (1 + (i % 2 ? 0.08 : -0.05))),
  centroid: 0.11,
};
const dNear = distance(graves, graves2);
console.log(`distancia misma fuente con ruido: ${dNear.toFixed(4)} (esperado < 0.2)`);
console.log(dNear < 0.2 ? "  OK" : "  FALLA");

/* ---- 5. separacion: la variacion intra-clase debe ser menor que inter-clase ---- */
console.log(
  dNear < dDiff / 3
    ? `  OK separacion: ${dNear.toFixed(3)} vs ${dDiff.toFixed(3)}`
    : `  FALLA separacion: ${dNear.toFixed(3)} vs ${dDiff.toFixed(3)}`
);

/* ---- 6. clasificacion con umbral ---- */
S.pads = [
  { name: "bombo", def: "bombo", samples: [graves], buffer: null, el: mkEl() },
  { name: "charles", def: "charles", samples: [agudos], buffer: null, el: mkEl() },
];
global.document.getElementById = () => {
  const e = mkEl();
  e.value = "0.35";
  return e;
};
const c1 = classify(graves2);
const c2 = classify(agudos);
const c3 = classify({ bands: [0.2, 0.2, 0.2, 0.1, 0.1, 0.1, 0.05, 0.03, 0.01, 0.01], centroid: 0.45 });
console.log(`clasificar bombo -> pad ${c1.pad} (esperado 0)`);
console.log(`clasificar charles -> pad ${c2.pad} (esperado 1)`);
console.log(`clasificar desconocido -> pad ${c3.pad} (esperado -1)`);
console.log(c1.pad === 0 && c2.pad === 1 && c3.pad === -1 ? "  OK" : "  FALLA");
