// Parsea el texto de la página /lectura-dia en un objeto estructurado con
// las 4 secciones que interesan: Primera lectura, Salmo, Segunda lectura
// (puede no existir, ej. en fiestas/ferias sin segunda lectura) y Evangelio.
// "Aclamación" se usa solo como marcador de corte, no se incluye en el
// resultado final.

const ENCABEZADOS = ['Primera lectura', 'Salmo', 'Segunda lectura', 'Aclamación', 'Evangelio'];

// Corta el texto en bloques, uno por cada encabezado reconocido que
// aparezca (en el orden en que aparecen realmente en la página, no un
// orden fijo, porque no todos los días tienen las mismas secciones).
function dividirEnBloques(lineas) {
  const indices = [];
  lineas.forEach((linea, i) => {
    if (ENCABEZADOS.includes(linea)) indices.push({ nombre: linea, i });
  });

  const bloques = {};
  indices.forEach((encabezado, idx) => {
    const fin = idx + 1 < indices.length ? indices[idx + 1].i : lineas.length;
    bloques[encabezado.nombre] = lineas.slice(encabezado.i + 1, fin);
  });
  return bloques;
}

// Estructura típica de un bloque de lectura (no aplica a Salmo):
//   [0] referencia bíblica          ("Dan 7, 9-10. 13-14")
//   [1] título/subtítulo (opcional) ("Su vestido era blanco como nieve")
//   [2] línea introductoria         ("Lectura de la profecía de Daniel.")
//   [...] cuerpo del texto
//   [n] fórmula de cierre           ("Palabra de Dios." / "Palabra del Señor.")
// Cualquier cosa después de la fórmula de cierre (navegación, títulos
// repetidos de otras secciones de la app) se descarta.
function extraerLectura(bloque, formulaCierre) {
  if (!bloque || bloque.length === 0) return null;

  const referencia = bloque[0] || null;
  let idx = 1;
  let titulo = null;
  if (bloque[idx] && !/^Lectura (de|del)/i.test(bloque[idx])) {
    titulo = bloque[idx];
    idx++;
  }

  const resto = bloque.slice(idx);
  const idxCierre = resto.findIndex((l) => l.toLowerCase().startsWith(formulaCierre.toLowerCase()));
  const cuerpo = idxCierre === -1 ? resto : resto.slice(0, idxCierre);

  return {
    referencia,
    titulo,
    texto: cuerpo.join('\n').trim() || null,
  };
}

function extraerSalmo(bloque) {
  if (!bloque || bloque.length === 0) return null;
  const referencia = bloque[0] || null;
  const texto = bloque.slice(1).join('\n').trim() || null;
  return { referencia, texto };
}

function parseLecturas(textoLecturasCrudo) {
  if (!textoLecturasCrudo) return null;

  const lineas = textoLecturasCrudo
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const bloques = dividirEnBloques(lineas);

  return {
    primeraLectura: extraerLectura(bloques['Primera lectura'], 'Palabra de Dios'),
    salmo: extraerSalmo(bloques['Salmo']),
    segundaLectura: bloques['Segunda lectura']
      ? extraerLectura(bloques['Segunda lectura'], 'Palabra de Dios')
      : null,
    evangelio: extraerLectura(bloques['Evangelio'], 'Palabra del Señor'),
  };
}

module.exports = { parseLecturas };
