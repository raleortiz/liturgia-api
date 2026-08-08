// Parsea el texto extraído de /detalle-dia-liturgico a un objeto estructurado.
//
// Formato esperado (confirmado con capturas reales del sitio):
//
//   05 Agosto, Miércoles. 18° Sem. del TO, Feria o Memoria libre, Verde o Blanco
//   Dedicación de la Basílica de Santa María      <- título opcional de fiesta/memoria
//   Misa
//   Opcional.
//   Leccionario Ferial año II:
//   Jr 31,1-7 / Sal Jr 31,10.11-12ab.13 (R. cf. 10d) / Mt 15,21-28.
//   Oficio
//   Ferial o de la Memoria libre; Salt. 2ª semana.
//   Notas
//   - Nuestra Señora de las Nieves:
//   Patrona de la ciudad de Pamplona.

function parseDiaLiturgico(textoCrudo) {
  if (!textoCrudo) {
    return { error: 'texto vacío', textoCrudo };
  }

  const lineas = textoCrudo
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const resultado = {
    encabezado: null,
    fecha: null,
    diaSemana: null,
    tiempoLiturgico: null,
    categoria: null,
    color: null,
    tituloFiesta: null,
    misa: { opcional: false, leccionario: null, lecturas: [] },
    oficio: null,
    notas: null,
    textoCrudo,
  };

  // El encabezado siempre es la primera línea con el patrón "DD Mes, ..."
  const idxEncabezado = lineas.findIndex((l) => /^\d{1,2}\s+\w+,/.test(l));
  if (idxEncabezado === -1) {
    resultado.error = 'No se encontró el encabezado esperado (patrón "DD Mes, ...")';
    return resultado;
  }
  resultado.encabezado = lineas[idxEncabezado];

  const partesEncabezado = resultado.encabezado.split(',').map((s) => s.trim());
  // [0] "05 Agosto"
  // [1] "Miércoles. 18° Sem. del TO"
  // [2] "Feria o Memoria libre"
  // [3] "Verde o Blanco"
  if (partesEncabezado[0]) resultado.fecha = partesEncabezado[0];
  if (partesEncabezado[1]) {
    const [diaSemana, ...resto] = partesEncabezado[1].split('.').map((s) => s.trim());
    resultado.diaSemana = diaSemana || null;
    resultado.tiempoLiturgico = resto.join('. ') || null;
  }
  if (partesEncabezado[2]) resultado.categoria = partesEncabezado[2];
  if (partesEncabezado[3]) resultado.color = partesEncabezado[3];

  const idxMisa = lineas.findIndex((l) => l === 'Misa');
  const idxOficio = lineas.findIndex((l) => l === 'Oficio');
  const idxNotas = lineas.findIndex((l) => l === 'Notas');

  // Título de fiesta/memoria opcional: lo que hay entre el encabezado y "Misa"
  if (idxMisa > idxEncabezado + 1) {
    resultado.tituloFiesta = lineas.slice(idxEncabezado + 1, idxMisa).join(' ');
  }

  if (idxMisa !== -1) {
    const finMisa = idxOficio !== -1 ? idxOficio : lineas.length;
    const bloqueMisa = lineas.slice(idxMisa + 1, finMisa);

    resultado.misa.opcional = bloqueMisa.some((l) => /^opcional\.?$/i.test(l));

    const lineaLeccionario = bloqueMisa.find((l) => /leccionario/i.test(l));
    if (lineaLeccionario) resultado.misa.leccionario = lineaLeccionario.replace(/:\s*$/, '');

    const lineaLecturas = bloqueMisa.find((l) => l.includes('/'));
    if (lineaLecturas) {
      resultado.misa.lecturas = lineaLecturas
        .replace(/\.$/, '')
        .split('/')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  if (idxOficio !== -1) {
    const finOficio = idxNotas !== -1 ? idxNotas : lineas.length;
    const bloqueOficio = lineas.slice(idxOficio + 1, finOficio).join(' ').trim();
    resultado.oficio = bloqueOficio || null;
  }

  if (idxNotas !== -1) {
    const bloqueNotas = lineas.slice(idxNotas + 1).join(' ').trim();
    resultado.notas = bloqueNotas || null;
  }

  return resultado;
}

module.exports = { parseDiaLiturgico };
