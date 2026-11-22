# drumbar

Batería digital disparada por sonido. Golpeás objetos reales y suenan samples de batería.

Web app sin instalación: usa el micrófono para detectar el golpe, lo compara con lo
que aprendiste de cada objeto y dispara el sample que le asignaste.

**Se usa acá: <https://ohdevaix01.github.io/drumbar/>**

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
30 ms y analiza ahí, con una ventana de 43 ms que arranca en el ataque.

El valor salió de un barrido de 0/10/20/30/45/60 ms midiendo cuánto se separan
cuatro objetos distintos: con 0 ms la separación es 3.4x, con 30 ms es 375x. Con
45 ms se acierta igual pero la app se siente 15 ms más lenta.

Cada golpe queda descrito por:

- **12 bandas de frecuencia** (logarítmicas, 50 Hz a 14 kHz), en dB y normalizadas
  por resta de la media. Queda la *forma* del espectro, sin importar cuán fuerte
  fue el golpe.
- **Centroide espectral** — dónde está el "peso" del sonido.
- **Decaimiento** — cuánto tarda en apagarse. Un objeto golpeado resuena; un
  click, una puerta o ruido de fondo se apagan al toque. Este rasgo es el que más
  ayuda a no disparar con cualquier cosa.

**Cada banda pesa distinto, y eso es la clave.** Al aprender se mide cuánto
varía cada banda en ese objeto. Una banda que suena siempre igual es muy
informativa y pesa mucho; una banda que se mueve (porque el golpe cae en otro
punto del objeto) pesa poco. Es un modelo gaussiano por banda.

Esto no es un detalle: con objetos reales, un k-NN con umbral se queda corto
porque la variación del mismo objeto es tan grande como la diferencia entre
objetos distintos. Medido: 0.70x de separación, o sea imposible de separar. Con
el modelo por banda, los mismos datos pasan de 50% a 100% de aciertos.

**Se exigen dos cosas para disparar:**

- El pad ganador tiene que explicar el golpe dentro de unos pocos desvíos. Esto
  frena los ruidos, que quedan lejísimos de todo lo aprendido.
- El ganador tiene que ser claramente mejor que el segundo pad. Esto frena un
  objeto que nunca se aprendió, que queda parecido a todos por igual.

Si el golpe no pasa los dos, no suena nada. Es a propósito: rechazar es
recuperable (golpeás de nuevo), confundir suena mal siempre.

El slider *Exigencia* mueve los dos límites. Más alto = acepta menos.

## Resultados medidos

Objetos sintéticos que se solapan en frecuencia (el caso difícil), variando
amplitud, afinación ±2%, amortiguamiento y fase entre golpes (lo que pasa al
golpear distintos puntos del mismo objeto). 5 golpes de entrenamiento y 19 de
prueba por objeto:

| Prueba | Resultado |
|---|---|
| Clasificar el objeto correcto | 92% |
| Confundir un objeto con otro | 0% |
| Rechazar ruidos (voz, siseo, click, roce) | 100% |
| Rechazar objetos nunca aprendidos | 93% |

Con objetos muy densos en resonancias (14 a 24 modos, más que cualquier cosa de
la casa) el detector se vuelve conservador: dispara el 75% de los golpes, y de
los que dispara acierta el 100%.

El código anterior a estos cambios rechazaba **0 de 5** ruidos de prueba y
clasificaba todo como un pad.

## Detección del golpe

El detector no espera a que el sonido se apague. Antes sí lo hacía: exigía que
el nivel bajara casi a silencio para aceptar otro golpe, y con un bombo de 500 ms
sonando eso eran 620 ms sin poder tocar. Ese era el problema real.

Ahora detecta el ataque por **flujo espectral**: cuánto crece la energía en cada
frecuencia entre un cuadro y el siguiente. Un golpe es un salto grande; la cola
de un sample, una nota sostenida o un objeto resonando no suben, bajan.

Dos detalles que hicieron falta:

- **Se mide solo arriba de 300 Hz.** Un bombo o un bajo viven en 60-150 Hz, y ahí
  una ventana corta no los resuelve: el nivel oscila y genera flujo falso. El
  ataque de un objeto golpeado, en cambio, tiene transitorio de banda ancha.
  Medido con un sample de 500 ms: ignorando el grave, la separación entre golpe
  y sample pasa de 1.1x a 22x.
- **Filtro paso-alto a 150 Hz** antes de analizar, por lo mismo. Un sample de
  500 ms queda 4.1x más débil que un golpe, y el golpe casi no se toca.

Resultado: dos golpes separados 60 ms dan dos disparos. Un redoble de 8 golpes
da 8. Y se puede tocar encima de un sample que está sonando.

## Anti-retroalimentación

Cuando un pad suena, el parlante dispara el micrófono, que dispara el parlante.
Por eso al disparar se cierra la detección un momento.

El bloqueo ya no dura todo el sample: dura el margen ajustable, con techo de
`blank + 60 ms`. Con auriculares no hay retrolimentación, así que el botón
*Auriculares* lo pone en 0 y podés tocar encima de lo que suena. Con parlante,
subilo hasta que no se dispare solo.

Además el micrófono nunca llega al parlante: el nodo del detector va a una
ganancia en 0.

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
