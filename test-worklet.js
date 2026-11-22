// Prueba el AudioWorklet real simulando el runtime de audio.
// Ojo: el evento "onset" ya no sale en el ataque, sale ~30 ms despues (cuando
// ya se puede analizar la resonancia). Los tests tienen que alimentar audio
// suficiente despues del golpe para que llegue.
const fs = require("fs");
const vm = require("vm");

let registered = null, posted = [];
const ctx = {
  sampleRate: 48000,
  currentTime: 0,
  console, Math, Float32Array, Array, Object,
  registerProcessor: (n, c) => { registered = { name: n, cls: c }; },
  AudioWorkletProcessor: class {
    constructor() { this.port = { postMessage: (m) => posted.push(m), onmessage: null }; }
  },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + "/detector-worklet.js", "utf8"), ctx);

if (!registered) { console.log("FALLA: no se registro el processor"); process.exit(1); }
console.log("processor registrado:", registered.name);

const SR = 48000;
let T = 0;
Object.defineProperty(ctx, "currentTime", { get: () => T, configurable: true });

const Det = registered.cls;

function feed(det, rms, frames, seed) {
  frames = frames || 128;
  const buf = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const s = Math.sin((i + (seed || 1) * 37) * 0.7) * 0.6 +
              Math.sin((i + (seed || 1) * 11) * 2.3) * 0.4;
    buf[i] = s * rms;
  }
  T += frames / SR;
  det.process([[buf]]);
}

// silencio: la ventana de analisis tiene que ver algo parecido a silencio
function silence(det, ms) {
  const blocks = Math.ceil((SR * ms / 1000) / 128);
  for (let i = 0; i < blocks; i++) feed(det, 0.0005, 128, 9000 + i);
}

// golpe con resonancia: ataque fuerte y despues cola que decae
function hit(det, rms, seed) {
  feed(det, rms * 0.4, 128, seed);
  feed(det, rms, 128, seed + 1);
  for (let i = 0; i < 14; i++) {
    feed(det, rms * Math.pow(0.82, i), 128, seed + 2 + i);
  }
}

function makeDet(thr) {
  posted = [];
  T = 0;
  const det = new Det({ processorOptions: { thr: thr || 3.5 } });
  silence(det, 400); // calibrar
  posted = [];
  return det;
}
const onsets = () => posted.filter((m) => m.type === "onset");

let ok = 0, fail = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "OK   " : "FALLA"} ${name}${extra ? " :: " + extra : ""}`);
  cond ? ok++ : fail++;
}

/* 1. calibracion */
posted = []; T = 0;
let d = new Det({ processorOptions: { thr: 3.5 } });
silence(d, 400);
const cal = posted.find((m) => m.type === "calibrated");
check("calibra y reporta piso", !!cal && cal.noiseFloor > 0,
  cal ? "piso=" + (cal.noiseFloor * 1000).toFixed(2) : "sin evento");

/* 2. silencio no dispara */
posted = [];
silence(d, 800);
check("silencio no dispara", onsets().length === 0, "disparos=" + onsets().length);

/* 3. golpe dispara (tras el retardo de analisis) */
d = makeDet();
hit(d, 0.08, 100);
silence(d, 150);
check("golpe dispara", onsets().length === 1, "disparos=" + onsets().length);

const on = onsets()[0];
check("el evento trae 12 bandas", on && on.bands && on.bands.length === 12,
  on ? "bandas=" + on.bands.length : "sin evento");
check("las bandas estan centradas en 0 (normalizadas)", on &&
  Math.abs(on.bands.reduce((a, b) => a + b, 0) / on.bands.length) < 0.01,
  on ? "media=" + (on.bands.reduce((a, b) => a + b, 0) / on.bands.length).toFixed(4) : "");
check("el evento trae decaimiento", on && typeof on.decay === "number",
  on ? "decay=" + on.decay.toFixed(3) : "");
check("el evento llega con retardo de analisis", on && on.delayMs >= 30,
  on ? "delay=" + on.delayMs.toFixed(1) + " ms" : "");

/* 4. sonido sostenido no retriggerea */
d = makeDet();
for (let i = 0; i < 60; i++) feed(d, 0.07, 128, 300 + i);
check("sonido sostenido no retriggerea", onsets().length <= 1,
  "disparos=" + onsets().length);

/* 5. pausa */
d = makeDet();
d.port.onmessage({ data: { type: "pause", value: true } });
posted = [];
hit(d, 0.08, 400);
silence(d, 200);
check("en pausa no dispara", onsets().length === 0, "disparos=" + onsets().length);

/* 6. al reanudar vuelve a detectar */
d.port.onmessage({ data: { type: "pause", value: false } });
d.port.onmessage({ data: { type: "calibrate" } });
silence(d, 400);
posted = [];
hit(d, 0.08, 500);
silence(d, 150);
check("al reanudar vuelve a detectar", onsets().length === 1, "disparos=" + onsets().length);

/* 7. anti-feedback */
d = makeDet();
d.port.onmessage({ data: { type: "suppress", ms: 300 } });
posted = [];
hit(d, 0.08, 600);
silence(d, 150);
check("anti-feedback bloquea el trigger", onsets().length === 0, "disparos=" + onsets().length);

/* 8. pasado el bloqueo vuelve a detectar */
T += 0.4;
posted = [];
hit(d, 0.08, 700);
silence(d, 150);
check("terminado el bloqueo vuelve a detectar", onsets().length === 1,
  "disparos=" + onsets().length);

/* 9. umbral alto ignora golpes flojos */
d = makeDet();
d.port.onmessage({ data: { type: "thr", value: 12 } });
posted = [];
hit(d, 0.006, 800);
silence(d, 200);
check("umbral alto ignora golpes flojos", onsets().length === 0, "disparos=" + onsets().length);

/* 10. umbral bajo acepta ese mismo golpe */
d = makeDet(1.6);
posted = [];
hit(d, 0.006, 850);
silence(d, 200);
check("umbral bajo acepta golpes flojos", onsets().length === 1, "disparos=" + onsets().length);

/* 11. el decaimiento distingue corto de largo */
function decayOf(rms, tailBlocks, seed) {
  const det = makeDet();
  posted = [];
  feed(det, rms * 0.4, 128, seed);
  feed(det, rms, 128, seed + 1);
  for (let i = 0; i < tailBlocks; i++) {
    feed(det, rms * Math.pow(0.97, i), 128, seed + 2 + i);
  }
  const o = onsets()[0];
  return o ? o.decay : -1;
}
const dShort = decayOf(0.08, 1, 900);
const dLong = decayOf(0.08, 30, 950);
check("decaimiento separa sonido corto de largo", dLong > dShort,
  `corto=${dShort.toFixed(2)} largo=${dLong.toFixed(2)}`);

/* 12. re-disparo rapido: el punto de todo el rediseno.
   Antes habia que esperar a que el sonido se apagara. Ahora dos golpes
   seguidos tienen que dar dos disparos, incluso encima de un sonido sonando. */
function twoHits(gapMs) {
  const det = makeDet();
  posted = [];
  hit(det, 0.08, 400);
  // relleno hasta completar la separacion pedida (un hit dura ~16 bloques)
  const hitBlocks = 16, hitMs = hitBlocks * 128 / SR * 1000;
  const padBlocks = Math.max(0, Math.round((gapMs - hitMs) / (128 / SR * 1000)));
  for (let i = 0; i < padBlocks; i++) feed(det, 0.001, 128, 700 + i);
  hit(det, 0.08, 500);
  silence(det, 200);
  return onsets().length;
}
check("dos golpes seguidos dan dos disparos", twoHits(60) === 2,
  "separacion 60 ms -> " + twoHits(60) + " disparos");
check("tres golpes seguidos dan tres disparos", (function(){
  const det = makeDet();
  posted = [];
  hit(det, 0.08, 400); hit(det, 0.08, 500); hit(det, 0.08, 600);
  silence(det, 200);
  return onsets().length;
})() === 3, "tres golpes encadenados");

/* 13. un golpe solo no dispara dos veces (el bug opuesto) */
check("un golpe no dispara dos veces", (function(){
  const det = makeDet();
  posted = [];
  hit(det, 0.08, 400);
  silence(det, 300);
  return onsets().length;
})() === 1, "un golpe");

/* 14. el grave de un sample sonando no dispara solo.
   El ataque inicial del sample SI es un transitorio real y dispara una vez
   (la app lo cubre con el bloqueo). Lo que no puede pasar es que la cola
   siga disparando mientras suena. */
check("un tono grave sonando no re-dispara", (function(){
  const det = makeDet();
  // arranca el tono antes de medir, para saltear el ataque inicial
  for (let b = 0; b < 30; b++) {
    const buf = new Float32Array(128);
    for (let i = 0; i < 128; i++) {
      const t = (b * 128 + i) / SR;
      buf[i] = (Math.sin(2 * Math.PI * 60 * t) * 0.5 +
                Math.sin(2 * Math.PI * 120 * t) * 0.2) * Math.exp(-t / 0.25) * 0.5;
    }
    T += 128 / SR;
    det.process([[buf]]);
  }
  posted = [];
  // sigue sonando 600 ms mas: no tiene que disparar
  for (let b = 30; b < 100; b++) {
    const buf = new Float32Array(128);
    for (let i = 0; i < 128; i++) {
      const t = (b * 128 + i) / SR;
      buf[i] = (Math.sin(2 * Math.PI * 60 * t) * 0.5 +
                Math.sin(2 * Math.PI * 120 * t) * 0.2) * Math.exp(-t / 0.25) * 0.5;
    }
    T += 128 / SR;
    det.process([[buf]]);
  }
  return onsets().length;
})() === 0, "cola de un tono grave");

console.log(`\n${ok} OK, ${fail} FALLA`);
process.exit(fail ? 1 : 0);
