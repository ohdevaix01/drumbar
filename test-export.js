// Prueba la exportacion real (encodeWav / encodeMp3) extraida de index.html
const fs = require("fs");
const vm = require("vm");

const html = fs.readFileSync(__dirname + "/index.html", "utf8");
const parts = html.split("<script>");
const script = parts[parts.length - 1].split("</script>")[0];

const mkEl = () => ({
  value: "100", textContent: "", innerHTML: "",
  classList: { add() {}, remove() {} }, style: {},
  children: [], insertBefore() {}, removeChild() {}, appendChild() {},
});
const ctx = {
  console, Math, JSON, Array, Object, Int16Array, Uint8Array, Float32Array,
  Float64Array, ArrayBuffer, DataView, parseInt, parseFloat, isNaN, Date,
  performance: { now: () => 0 },
  window: { addEventListener() {} },
  document: { getElementById: () => mkEl(), createElement: () => mkEl(), addEventListener() {} },
  localStorage: { getItem: () => null, setItem() {} },
  navigator: { mediaDevices: {} },
  setTimeout: () => 0,
  setInterval: () => 0,
  MediaRecorder: function () {},
  URL: { createObjectURL: () => "", revokeObjectURL() {} },
  lamejs: null,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(script, ctx);

let ok = 0, fail = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "OK  " : "FALLA"} ${name}${extra ? " :: " + extra : ""}`);
  cond ? ok++ : fail++;
}

/* ---------- 1. WAV ---------- */
const SR = 48000, N = SR; // 1 segundo
const chans = [new Float32Array(N), new Float32Array(N)];
for (let i = 0; i < N; i++) {
  const v = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.8;
  chans[0][i] = v;
  chans[1][i] = -v;
}
const fakeBuf = {
  numberOfChannels: 2, sampleRate: SR, length: N,
  getChannelData: (c) => chans[c],
};
const wav = ctx.encodeWav(fakeBuf);
const dv = new DataView(wav);
function str(off, len) {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + i));
  return s;
}
check("WAV cabecera RIFF", str(0, 4) === "RIFF");
check("WAV cabecera WAVE", str(8, 4) === "WAVE");
check("WAV bloque fmt", str(12, 4) === "fmt ");
check("WAV canales = 2", dv.getUint16(22, true) === 2);
check("WAV sampleRate = 48000", dv.getUint32(24, true) === SR);
check("WAV bits = 16", dv.getUint16(34, true) === 16);
check("WAV bloque data", str(36, 4) === "data");
const dataLen = dv.getUint32(40, true);
check("WAV tamano data correcto", dataLen === N * 2 * 2, dataLen + " vs " + N * 2 * 2);
check("WAV tamano total correcto", wav.byteLength === 44 + dataLen);
// verificar que el PCM tiene la senoidal
let peak = 0;
for (let i = 0; i < 200; i++) {
  const s = dv.getInt16(44 + i * 4, true);
  peak = Math.max(peak, Math.abs(s));
}
check("WAV contiene audio (pico > 20000)", peak > 20000, "pico=" + peak);

/* ---------- 2. MP3 ---------- */
const lameCtx = { console, Math, Int8Array, Int16Array, Int32Array, Float32Array, Float64Array, Array, Object, Uint8Array, ArrayBuffer, DataView, isNaN, parseInt };
lameCtx.window = lameCtx; lameCtx.self = lameCtx;
vm.createContext(lameCtx);
vm.runInContext(fs.readFileSync(__dirname + "/lame.min.js", "utf8"), lameCtx);
ctx.lamejs = lameCtx.lamejs;

const mp3 = ctx.encodeMp3(fakeBuf, 192);
check("MP3 generado", mp3 && mp3.length > 1000, mp3.length + " bytes");
check("MP3 header valido", mp3[0] === 0xFF && (mp3[1] & 0xE0) === 0xE0,
  "0x" + mp3[0].toString(16) + " 0x" + mp3[1].toString(16));
// ID3 opcional al inicio: buscar sync en los primeros bytes
let syncAt = -1;
for (let i = 0; i < Math.min(2000, mp3.length - 1); i++) {
  if (mp3[i] === 0xFF && (mp3[i + 1] & 0xE0) === 0xE0) { syncAt = i; break; }
}
check("MP3 tiene frame sync", syncAt >= 0, "en offset " + syncAt);
const ratio = (mp3.length / (N * 2 * 2)) * 100;
check("MP3 comprime (192kbps ~ 10% de PCM)", ratio < 20, ratio.toFixed(1) + "%");

/* ---------- 3. MP3 mono ---------- */
const monoBuf = {
  numberOfChannels: 1, sampleRate: SR, length: N,
  getChannelData: () => chans[0],
};
const mp3m = ctx.encodeMp3(monoBuf, 128);
check("MP3 mono generado", mp3m && mp3m.length > 1000, mp3m.length + " bytes");
check("MP3 mono header valido", mp3m[0] === 0xFF && (mp3m[1] & 0xE0) === 0xE0);

/* ---------- 4. silencio no rompe ---------- */
const silBuf = {
  numberOfChannels: 1, sampleRate: SR, length: 4800,
  getChannelData: () => new Float32Array(4800),
};
const mp3s = ctx.encodeMp3(silBuf, 192);
check("MP3 de silencio no falla", mp3s.length > 0, mp3s.length + " bytes");

console.log(`\n${ok} OK, ${fail} FALLA`);
process.exit(fail ? 1 : 0);
