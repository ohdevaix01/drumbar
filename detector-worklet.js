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

    this.prevRms = 0;
    this.lastOnsetT = -1e9;
    this.blankUntilT = -1e9;

    // Deteccion de ataques por FLUJO ESPECTRAL.
    //
    // El metodo anterior exigia que el nivel de audio bajara casi a silencio
    // para aceptar otro golpe (`armed`). Con un sample de bateria sonando, o
    // con un objeto que resuena, el nivel nunca baja y no se puede tocar de
    // nuevo hasta que se apaga: eso es lo que se sentia como "tengo que esperar
    // a que termine de sonar".
    //
    // El flujo espectral mide cuanto CRECE la energia en cada frecuencia entre
    // un bloque y el siguiente. Un golpe es un salto grande y de banda ancha.
    // La cola de un sample, una nota sostenida o un objeto resonando no suben:
    // bajan. Asi se detecta el ataque aunque haya sonido sonando.
    this.FRAME = 512;          // ~10.7 ms: suficiente resolucion en frecuencia
    this.magRe = new Float32Array(this.FRAME);
    this.magIm = new Float32Array(this.FRAME);
    this.mag = new Float32Array(this.FRAME / 2);
    this.prevMag = new Float32Array(this.FRAME / 2);
    // El flujo se mide solo arriba de esta frecuencia. Un sample de bombo o
    // bajo vive en 60-150 Hz, y ahi la ventana corta no lo resuelve: el nivel
    // oscila y genera flujo falso que dispara solo. El ataque de un objeto
    // golpeado, en cambio, tiene transitorio de banda ancha. Medido con un
    // sample de 500 ms: ignorando abajo de 400 Hz la separacion golpe/sample
    // pasa de 1.1x a 22x, y el golpe solo pierde 20% de su flujo.
    this.FLUX_MIN_HZ = 300;
    this.hannMag = new Float32Array(this.FRAME);
    for (var q = 0; q < this.FRAME; q++) {
      this.hannMag[q] = 0.5 * (1 - Math.cos((2 * Math.PI * q) / (this.FRAME - 1)));
    }
    // 200 bloques = ~540 ms de historia para el umbral adaptativo
    this.fluxHist = new Float32Array(120);
    this.fluxIdx = 0;
    this.fluxReady = 0;
    this.fluxAcc = 0;          // muestras nuevas desde el ultimo calculo
    this.fluxArmed = true;     // histeresis: hay que bajar del umbral para re-disparar
    this.FLUX_FACTOR = 2.2;    // cuanto por encima del ruido de fondo
    this.FLUX_FLOOR = 0.0009;  // piso absoluto, para no disparar en silencio
    // Un objeto resonando produce flujo positivo por batido entre sus modos:
    // medido hasta 0.049 despues del ataque, contra 0.68 en el ataque. Con solo
    // la mediana de fondo (0.003) eso pasaba el umbral y disparaba de nuevo.
    // Se compara tambien contra el pico reciente, que decae: asi la cola de un
    // golpe queda por debajo pero un golpe nuevo y flojo igual entra.
    // Paso-alto antes de analizar. Los objetos de la casa resuenan arriba de
    // 150 Hz; un bombo o un bajo de un sample viven en 60-120 Hz. Ese grave
    // hace que un sample sonando genere flujo falso y tape el golpe siguiente.
    // Medido: sacando el grave, un sample de 500 ms pasa de 1.9x a 4.1x mas
    // debil que un golpe, y el golpe casi no se toca (0.214 -> 0.198).
    this.HP_FC = 150;
    this.hpA = 1 / (1 + 2 * Math.PI * this.HP_FC / this.sr);
    this.hpPrevX = 0;
    this.hpPrevY = 0;
    this.env = 0;
    this.envPrev = 0;
    this.ENV_DECAY = 0.86;
    // Flujo del ultimo golpe aceptado. Un golpe nuevo tiene que superar el 35%
    // de eso: asi la cola de una resonancia (7%) no re-dispara, pero un golpe
    // mas suave que el anterior si entra.
    // Referencia del ultimo golpe. Decae lento: el mismo golpe mide entre 0.28
    // y 1.08 de flujo segun donde caiga respecto del cuadro (3.8x), asi que una
    // referencia que no se olvide tapa los golpes siguientes.
    this.refFlux = 0;
    this.REATTACK_RATIO = 0.30;
    this.REF_DECAY = 0.985;
    // separacion minima entre ataques: es lo que tarda la ventana de analisis.
    // 35 ms permite ~28 golpes por segundo, mas que cualquier redoble.
    this.RETRIG_MS = 35;

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
      if (d.type === "calibrate") {
        this.calFrames = 0; this.calibrated = false; this.prevRms = 0;
        this.pending = null; this.fluxReady = 0;
        for (var z = 0; z < this.fluxHist.length; z++) this.fluxHist[z] = 0;
      }
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

  // Flujo espectral del ultimo FRAME de muestras. Devuelve cuanto crecio la
  // energia, sumando solo las frecuencias que subieron (las que bajan no
  // cuentan: un sonido que se apaga no es un golpe).
  spectralFlux() {
    var F = this.FRAME, re = this.magRe, im = this.magIm, i, k;
    var pos = (this.ringPos - F + this.N) % this.N;
    for (i = 0; i < F; i++) {
      var idx = (pos + i) % this.N;
      re[i] = this.ring[idx] * this.hannMag[i];
      im[i] = 0;
    }
    fft(re, im);
    var bins = F / 2, flux = 0;
    var kmin = Math.ceil(this.FLUX_MIN_HZ / (this.sr / F));
    for (k = 0; k < bins; k++) {
      var m = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / bins;
      this.mag[k] = m;
      if (k >= kmin) {
        var diff = m - this.prevMag[k];
        if (diff > 0) flux += diff;
      }
    }
    for (k = 0; k < bins; k++) this.prevMag[k] = this.mag[k];
    return flux;
  }

  // Umbral adaptativo: mediana del flujo reciente por 3. Usar la mediana y no
  // la media evita que los propios golpes suban el umbral y tapen al siguiente.
  fluxThreshold() {
    var n = this.fluxReady, i, j, tmp, vals;
    if (n < 8) return this.FLUX_FLOOR;
    vals = [];
    for (i = 0; i < n; i++) vals.push(this.fluxHist[i]);
    // insercion: n <= 200, se llama 93 veces por segundo, es barato
    for (i = 1; i < n; i++) {
      tmp = vals[i];
      for (j = i - 1; j >= 0 && vals[j] > tmp; j--) vals[j + 1] = vals[j];
      vals[j + 1] = tmp;
    }
    return Math.max(vals[n >> 1] * this.FLUX_FACTOR, this.FLUX_FLOOR);
  }

  process(inputs) {
    var input = inputs[0];
    if (!input || !input[0]) return true;
    var buf = input[0], len = buf.length, i, sum = 0, rms, now = currentTime;

    for (i = 0; i < len; i++) sum += buf[i] * buf[i];
    rms = Math.sqrt(sum / len);

    var hpRmsSum = 0;
    for (i = 0; i < len; i++) {
      var x = buf[i];
      var y = this.hpA * (this.hpPrevY + x - this.hpPrevX);
      this.hpPrevY = y; this.hpPrevX = x;
      this.ring[this.ringPos] = y;
      this.ringPos = (this.ringPos + 1) % this.N;
      hpRmsSum += y * y;
    }
    rms = Math.sqrt(hpRmsSum / len);

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

    // --- deteccion del ataque por flujo espectral ---
    //
    // Mide cuanto CRECE la energia entre un cuadro y el siguiente. Un golpe es
    // un salto grande; la cola de un sample o una nota sostenida no suben.
    // Asi se detecta el ataque aunque haya sonido sonando, que es lo que antes
    // no se podia: el detector exigia silencio para re-armar.
    this.fluxAcc += len;
    if (this.fluxAcc >= this.FRAME) {
      this.fluxAcc = 0;
      var flux = this.spectralFlux();

      this.fluxHist[this.fluxIdx] = flux;
      this.fluxIdx = (this.fluxIdx + 1) % this.fluxHist.length;
      if (this.fluxReady < this.fluxHist.length) this.fluxReady++;

      // Dos condiciones: supera el ruido de fondo (mediana del flujo reciente)
      // y supera una fraccion del ultimo golpe aceptado. La segunda es la que
      // evita que la cola de un objeto resonando re-dispare: esa cola produce
      // flujo por batido entre modos, pero queda muy por debajo del ataque.
      var thrFlux = Math.max(
        this.fluxThreshold(),
        this.refFlux * this.REATTACK_RATIO
      );
      var over = flux > thrFlux;
      if (!over) this.fluxArmed = true;

      var blanked = now < this.blankUntilT;
      var spaced = now - this.lastOnsetT > this.RETRIG_MS / 1000;
      var loudEnough = rms > this.noiseFloor * this.thr;

      if (this.fluxArmed && over && !blanked && spaced && !this.pending && loudEnough) {
        this.fluxArmed = false;
        this.lastOnsetT = now;
        this.refFlux = Math.max(flux, this.refFlux * this.REF_DECAY);
        this.pending = { t: now, rms: rms, pos: this.ringPos };
      }
      this.refFlux *= this.REF_DECAY;
    }

    this.prevRms = rms;

    return true;
  }
}

registerProcessor("hit-detector", HitDetector);
