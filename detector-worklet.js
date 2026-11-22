// Detector de golpes en AudioWorklet. Corre en el hilo de audio, bloque a
// bloque (128 frames = 2.7 ms a 48 k), sin pasar por el hilo principal.
//
// Lo importante del reconocimiento: la huella NO se toma en el ataque. En los
// primeros milisegundos todos los golpes son ruido de banda ancha y se parecen
// entre si. La identidad del objeto esta en la resonancia que sigue: por eso se
// espera ~45 ms y recien ahi se analiza, con una ventana de 85 ms.
"use strict";

var NBANDS = 12;

function fft(re, im) {
  var n = re.length, i, j, bit, len, ang, wr, wi, k, cr, ci, ur, ui, vr, vi, ncr, t;
  for (i = 1, j = 0; i < n; i++) {
    bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (len = 2; len <= n; len <<= 1) {
    ang = (-2 * Math.PI) / len; wr = Math.cos(ang); wi = Math.sin(ang);
    for (i = 0; i < n; i += len) {
      cr = 1; ci = 0;
      for (k = 0; k < len / 2; k++) {
        ur = re[i + k]; ui = im[i + k];
        vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

class HitDetector extends AudioWorkletProcessor {
  constructor(options) {
    super();
    var o = (options && options.processorOptions) || {};
    this.thr = o.thr || 3.5;
    this.blankMs = o.blankMs || 120;
    this.paused = false;
    this.sr = sampleRate;

    this.noiseFloor = 0.008;
    this.calFrames = 0;
    this.calibrated = false;

    this.armed = true;
    this.prevRms = 0;
    this.lastOnsetT = -1e9;
    this.blankUntilT = -1e9;

    // 170 ms de historia para poder analizar la resonancia despues del ataque
    this.N = 8192;
    this.ring = new Float32Array(this.N);
    this.ringPos = 0;

    // ventana de analisis: 4096 = 85 ms a 48 k
    // 2048 muestras = 43 ms. Mas ancho no aporta: la ventana se llena de cola
    // del propio sonido y diluye la forma del espectro.
    this.WIN = 2048;
    this.hann = new Float32Array(this.WIN);
    for (var i = 0; i < this.WIN; i++) {
      this.hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (this.WIN - 1)));
    }

    // 30 ms: medido contra alternativas (0/10/20/45/60). Con 45 se acierta
    // igual pero se siente 15 ms mas lento, y con menos de 20 el ataque todavia
    // domina el espectro y los objetos se confunden.
    this.SKIP_MS = 30;
    this.MAX_DELAY_MS = 400;
    this.pending = null;

    var fmin = 50, fmax = Math.min(14000, this.sr / 2 * 0.95);
    this.edges = [];
    for (var b = 0; b <= NBANDS; b++) {
      this.edges.push(
        Math.round((fmin * Math.pow(fmax / fmin, b / NBANDS)) / (this.sr / 2) * (this.WIN / 2))
      );
    }

    this.port.onmessage = (e) => {
      var d = e.data || {};
      if (d.type === "thr") this.thr = d.value;
      if (d.type === "pause") { this.paused = !!d.value; this.pending = null; }
      if (d.type === "calibrate") { this.calFrames = 0; this.calibrated = false; this.armed = true; this.prevRms = 0; }
      if (d.type === "suppress") this.blankUntilT = currentTime + (d.ms || 0) / 1000;
      if (d.type === "noise") this.noiseFloor = Math.max(d.value, 0.0008);
    };
  }

  // Espectro de la ventana que ARRANCA en el ataque. Si la ventana terminara en
  // el instante de analisis, incluiria el silencio previo al golpe y diluiria
  // el espectro con lo que no es el objeto.
  features(fromPos, avail) {
    var W = this.WIN, re = new Float32Array(W), im = new Float32Array(W), i;
    for (i = 0; i < W; i++) {
      if (i >= avail) { re[i] = 0; im[i] = 0; continue; }
      var idx = ((fromPos + i) % this.N + this.N) % this.N;
      re[i] = this.ring[idx] * this.hann[i];
    }
    fft(re, im);

    var bins = W / 2;
    var bands = new Array(NBANDS), num = 0, den = 0, b, a, z, s, c, mag;

    for (b = 0; b < NBANDS; b++) {
      a = Math.max(0, Math.min(this.edges[b], bins - 1));
      z = Math.max(a + 1, Math.min(this.edges[b + 1], bins));
      s = 0; c = 0;
      for (i = a; i < z; i++) {
        mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
        s += mag;
        c += mag * ((i * this.sr) / W);
      }
      // dB por banda: la energia lineal queda dominada por la banda mas fuerte
      // y aplasta la forma del resto del espectro
      bands[b] = 20 * Math.log10(s / (z - a) + 1e-9);
      num += c; den += s;
    }

    // resta de la media: queda la forma del espectro, sin depender de cuan
    // fuerte fue el golpe
    var mean = 0;
    for (b = 0; b < NBANDS; b++) mean += bands[b];
    mean /= NBANDS;
    for (b = 0; b < NBANDS; b++) bands[b] -= mean;

    var centroid = den > 0 ? num / den : 0;
    return {
      bands: bands,
      centroid: Math.max(0, Math.min(1, centroid / 6000)),
      decay: this.decay(fromPos, avail),
    };
  }

  // Tiempo que tarda el sonido en apagarse. Un objeto golpeado resuena; un
  // click, un golpe de puerta o un ruido de fondo se apagan al toque. Es el
  // rasgo que mas ayuda a no disparar con cualquier cosa.
  decay(fromPos, avail) {
    var i, k, peak = 0, peakAt = 0;
    var start = fromPos;

    // solo sobre las muestras que existen despues del ataque
    var hop = Math.max(1, Math.floor(this.sr * 0.002));
    var nEnv = Math.floor(Math.min(avail, this.WIN) / hop);
    if (nEnv < 3) return 0;
    var e = new Float32Array(nEnv);
    for (k = 0; k < nEnv; k++) {
      var s2 = 0;
      for (i = 0; i < hop; i++) {
        var idx = ((start + k * hop + i) % this.N + this.N) % this.N;
        var v = this.ring[idx];
        s2 += v * v;
      }
      e[k] = Math.sqrt(s2 / hop);
      if (e[k] > peak) { peak = e[k]; peakAt = k; }
    }
    if (peak <= 0) return 0;

    // buscar donde cae al 25% del pico
    var thr = peak * 0.25, endK = peakAt;
    for (k = peakAt; k < nEnv; k++) {
      if (e[k] < thr) { endK = k; break; }
      endK = k;
    }
    var decayMs = (endK - peakAt) * (hop / this.sr) * 1000;

    // escala logaritmica entre 3 ms y lo que dura la ventana disponible
    var top = Math.max(12, (nEnv * hop / this.sr) * 1000);
    var v2 = Math.log10(Math.max(decayMs, 3) / 3) / Math.log10(top / 3);
    return Math.max(0, Math.min(1, v2));
  }

  process(inputs) {
    var input = inputs[0];
    if (!input || !input[0]) return true;
    var buf = input[0], len = buf.length, i, sum = 0, rms, now = currentTime;

    for (i = 0; i < len; i++) sum += buf[i] * buf[i];
    rms = Math.sqrt(sum / len);

    for (i = 0; i < len; i++) {
      this.ring[this.ringPos] = buf[i];
      this.ringPos = (this.ringPos + 1) % this.N;
    }

    if (this.paused) { this.prevRms = rms; this.pending = null; return true; }

    if (!this.calibrated) {
      this.calFrames++;
      if (this.calFrames === 1) this.noiseFloor = rms || 0.005;
      else this.noiseFloor = this.noiseFloor * 0.92 + rms * 0.08;
      if (this.calFrames > 60) {
        this.calibrated = true;
        this.noiseFloor = Math.max(this.noiseFloor, 0.0008);
        this.port.postMessage({ type: "calibrated", noiseFloor: this.noiseFloor });
      }
      return true;
    }

    // ataque pendiente: cuando pasaron los 45 ms se analiza la resonancia
    if (this.pending) {
      var elapsedMs = (now - this.pending.t) * 1000;
      if (elapsedMs >= this.SKIP_MS) {
        var avail = ((this.ringPos - this.pending.pos) % this.N + this.N) % this.N;
        var f = this.features(this.pending.pos, avail);
        this.port.postMessage({
          type: "onset",
          rms: this.pending.rms,
          noiseFloor: this.noiseFloor,
          bands: f.bands,
          centroid: f.centroid,
          decay: f.decay,
          t: this.pending.t,
          delayMs: elapsedMs,
        });
        this.pending = null;
      } else if (elapsedMs > this.MAX_DELAY_MS) {
        // el ataque quedo muy viejo (sonido continuo): se descarta
        this.pending = null;
      }
    }

    if (rms < this.noiseFloor * 2.5) this.noiseFloor = this.noiseFloor * 0.995 + rms * 0.005;

    var gate = this.noiseFloor * this.thr;
    if (rms < gate * 0.55) this.armed = true;

    var transient = rms > this.prevRms * 1.3;
    this.prevRms = rms;

    var blanked = now < this.blankUntilT;
    var spaced = now - this.lastOnsetT > 0.045;

    if (this.armed && !blanked && rms > gate && transient && spaced && !this.pending) {
      this.armed = false;
      this.lastOnsetT = now;
      this.pending = { t: now, rms: rms, pos: this.ringPos };
    }

    return true;
  }
}

registerProcessor("hit-detector", HitDetector);
