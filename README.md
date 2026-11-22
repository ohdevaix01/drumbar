# drumbar

Batería digital disparada por sonido. Golpeás objetos reales y suenan samples de batería.

Web app sin instalación: usa el micrófono para detectar el golpe, lo compara con lo
que aprendiste de cada objeto y dispara el sample que le asignaste.

## Cómo se usa

1. **Encender** — abre el micrófono y calibra el ruido ambiente (quedate callado 2 s).
2. Tocá un pad y después **Aprender pad** — golpeá el objeto 5 veces.
3. Repetí con otros pads usando objetos distintos.
4. Golpeá cualquier objeto aprendido y suena su sample.

Podés cargar tus propios WAV/MP3 con el selector de archivos (uno por pad, en orden).
Lo aprendido queda guardado en el navegador.

## Cómo distingue los objetos

No hay machine learning: hay análisis espectral con tres rasgos.

**El detalle que importa:** la huella no se toma en el ataque. En los primeros
milisegundos todos los golpes son ruido de banda ancha y se parecen entre sí. La
identidad del objeto está en la resonancia que sigue, así que el detector espera
45 ms y analiza ahí, con una ventana de 85 ms.

Cada golpe queda descrito por:

- **12 bandas de frecuencia** (logarítmicas, 50 Hz a 14 kHz), en dB y normalizadas
  por resta de la media. Queda la *forma* del espectro, sin importar cuán fuerte
  fue el golpe.
- **Centroide espectral** — dónde está el "peso" del sonido.
- **Decaimiento** — cuánto tarda en apagarse. Un objeto golpeado resuena; un
  click, una puerta o ruido de fondo se apagan al toque. Este rasgo es el que más
  ayuda a no disparar con cualquier cosa.

La clasificación promedia las 3 muestras más cercanas de cada pad (k-NN con k=3),
así una muestra rara no arrastra la decisión. Si la mejor distancia supera la
tolerancia, el golpe se rechaza y no suena nada.

## Anti-retroalimentación

Cuando un pad suena, el parlante dispara el micrófono, que dispara el parlante.
Medido en simulación: 5 golpes → 5 disparos en loop sin protección.

La solución: al disparar se cierra la detección por la duración del sample más un
margen ajustable (120 ms por defecto). Con eso: 5 golpes → 0 disparos.

Además el micrófono nunca llega al parlante: el nodo del detector va a una
ganancia en 0.

Si igual se dispara solo, subí el slider. Con auriculares podés bajarlo a 0.

## Latencia

El detector corre en un **AudioWorklet**, en el hilo de audio, bloque a bloque
(128 frames = 2.7 ms a 48 kHz). `ScriptProcessor` queda solo como respaldo.

| Etapa | Típico |
|---|---|
| Detección | 2.7 ms |
| Motor de audio | 5-10 ms |
| Salida | 10-20 ms |
| Micrófono | 5-20 ms |
| **Total** | **25-50 ms** |

Con auriculares con cable: 15-25 ms. **No uses Bluetooth** — agrega 100-200 ms y
se siente mal.

El botón **Medir latencia** hace una medición real: emite un click, lo capta el
micrófono y mide cuánto tardó. No es una tabla teórica, es tu equipo.

## Grabación

Graba **la mezcla** (lo que suena), no el micrófono. Exporta en MP3 192 kbps
(con lamejs) o WAV sin pérdida.

## Tests

```bash
node test-discrim.js   # discriminación de objetos y rechazo de ruidos
node test-worklet.js   # detector: pausa, anti-feedback, umbrales, decaimiento
node test-export.js    # WAV y MP3 válidos
node test.js           # FFT y clasificación
```

`test-discrim.js` sintetiza cuatro objetos con resonancias físicamente distintas
(madera, metal, plástico, vidrio) y cuatro ruidos que no son golpes (voz, siseo,
click, roce), y mide aciertos y rechazos.

## Licencia

MIT
