require('dotenv').config();

const express = require('express');
const cheerio = require('cheerio');
const cors = require('cors');
const { Pool } = require('pg'); // Mover arriba

const app = express();
const PORT = process.env.PORT || 3000;

// 1. CONFIGURACIÓN DEL CONFIG DE EXPRESS Y PERMISOS (DEBE IR PRIMERO)
app.use(cors());
app.use(express.json());
// 🛠️ Hace que la carpeta "public" sea accesible desde la web
app.use(express.static('public'));
// 🏠 Ruta principal: Cuando entres a la URL base, abrirá tu Panel de Administración
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/admin.html');
});

// 2. CONEXIÓN A POSTGRESQL (MOVER ARRIBA)
//const pool = new Pool({
//  user: process.env.DB_USER,
//  host: process.env.DB_HOST,
//  database: process.env.DB_NAME,
//  password: process.env.DB_PASSWORD,
//  port: process.env.DB_PORT,
//  ssl: {
//    rejectUnauthorized: false 
//  }
//});

//2  LAS VARIABLES SE CONFIGURAN EN RENDER
// 2. CONEXIÓN A POSTGRESQL (MOVER ARRIBA)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false 
  }
});


// 3. RUTAS DE LAS CANCIONES (MOVER ARRIBA PARA QUE SE REGISTREN ANTES DEL SCRAPER)
app.get('/api/canciones', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, titulo, artista, url_audio, letra, clase FROM canciones ORDER BY id DESC');
    res.json(result.rows); 
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener las canciones de la base de datos' });
  }
});

app.post('/api/canciones', async (req, res) => {
  const { titulo, artista, clase, url_audio, letra } = req.body;
  
  if (!titulo || !artista || !url_audio) {
    return res.status(400).json({ error: 'Todos los campos básicos son obligatorios.' });
  }

  try {
    const query = 'INSERT INTO canciones (titulo, artista, clase, url_audio, letra) VALUES ($1, $2, $3, $4, $5) RETURNING *';
    const result = await pool.query(query, [titulo, artista, clase || 'Ordinario', url_audio, letra || '']);
    res.status(201).json({ message: 'Canción agregada con éxito', cancion: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar la canción' });
  }
});

app.delete('/api/canciones/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM canciones WHERE id = $1', [id]);
    res.json({ message: 'Canción eliminada correctamente' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar la canción' });
  }
});

// 3.1 NUEVA RUTA: Actualizar una canción existente por ID
app.put('/api/canciones/:id', async (req, res) => {
  const { id } = req.params;
  const { titulo, artista, clase, url_audio, letra } = req.body;

  if (!titulo || !artista || !url_audio) {
    return res.status(400).json({ error: 'Todos los campos básicos son obligatorios.' });
  }

  try {
    const query = `
      UPDATE canciones 
      SET titulo = $1, artista = $2, clase = $3, url_audio = $4, letra = $5 
      WHERE id = $6 
      RETURNING *`;
    
    const result = await pool.query(query, [titulo, artista, clase || 'Ordinario', url_audio, letra || '', id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Canción no encontrada.' });
    }

    res.json({ message: 'Canción actualizada con éxito', cancion: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar la canción en la base de datos' });
  }
});

// 4. FUNCIÓN AUTOMÁTICA DE LA TABLA (MOVER ARRIBA)
const inicializarTablaCanciones = async () => {
  const querySQL = `
    CREATE TABLE IF NOT EXISTS canciones (
        id SERIAL PRIMARY KEY,
        clase VARCHAR(25) NOT NULL,
        titulo VARCHAR(255) NOT NULL,
        artista VARCHAR(255) NOT NULL,
        url_audio TEXT NOT NULL,
        letra TEXT, -- 👈 NUEVO: Almacena miles de caracteres de forma segura
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  try {
    await pool.query(querySQL);
    
    // Ejecuta una consulta extra para asegurar que la columna exista si la tabla ya estaba creada
    await pool.query("ALTER TABLE canciones ADD COLUMN IF NOT EXISTS letra TEXT;");
    await pool.query("ALTER TABLE canciones ADD COLUMN IF NOT EXISTS clase VARCHAR(25) NOT NULL DEFAULT '';");
    
    console.log("✅ Base de datos lista: Tabla 'canciones' y campo 'letra' verificados.");
  } catch (err) {
    console.error("❌ Error al intentar inicializar la base de datos:", err);
  }
};

inicializarTablaCanciones();

// 5. Fuente 1: liturgiadelashoras.github.io (Primera/Segunda Lectura, Salmo) ----------

const MESES = ['ene_no_usar', 'ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MARCADORES_OFICIO = ['SALMODIA', 'PRIMERA LECTURA', 'RESPONSORIO', 'SEGUNDA LECTURA', 'RESPONSORIO', 'ORACIÓN', 'CONCLUSIÓN'];

function parseOficio(html) {
  const $ = cheerio.load(html);
  $('br').replaceWith('\n');
  $('hr').replaceWith('\n---\n');

  const texto = $('#cuerpo').text()
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const posiciones = [];
  let cursor = 0;
  for (const marcador of MARCADORES_OFICIO) {
    const idx = texto.indexOf(marcador, cursor);
    if (idx === -1) continue;
    posiciones.push({ nombre: marcador, idx });
    cursor = idx + marcador.length;
  }

  const secciones = {};
  const contador = {};
  for (let i = 0; i < posiciones.length; i++) {
    const actual = posiciones[i];
    const siguiente = posiciones[i + 1];
    const inicio = actual.idx + actual.nombre.length;
    const fin = siguiente ? siguiente.idx : texto.length;
    let contenido = texto.slice(inicio, fin).trim();

    let clave = actual.nombre.toLowerCase().replace(/\s+/g, '_').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    contador[clave] = (contador[clave] || 0) + 1;
    if (contador[clave] > 1) clave = `${clave}_${contador[clave]}`;
    secciones[clave] = contenido;
  }
  return secciones;
}

async function obtenerOficio(anio, mesNum, diaNum) {
  const mesAbrev = MESES[mesNum];
  const diaFormateado = String(diaNum).padStart(2, '0');
  const url = `https://liturgiadelashoras.github.io/sync/${anio}/${mesAbrev}/${diaFormateado}/oficio.htm`;

  const respuesta = await fetch(url);
  if (!respuesta.ok) return { secciones: {}, url, ok: false };

  const html = await respuesta.text();
  return { secciones: parseOficio(html), url, ok: true };
}

// 6. Fuente 2: aciprensa.com/calendario (Evangelio) 

const ETIQUETAS_ACI = ['Primera Lectura', 'Segunda Lectura', 'Salmo Responsorial', 'Evangelio'];

function parseAciprensa(html) {
  const $ = cheerio.load(html);
  $('br').replaceWith(' ');

  const resultado = {};
  $('li').each((_, el) => {
    const $el = $(el);
    const etiqueta = $el.find('b').first().text().trim();
    if (!ETIQUETAS_ACI.includes(etiqueta)) return;

    const cita = $el.find('i').first().text().trim();

    const versos = [];
    $el.find('.readings__verse-container').each((__, v) => {
      versos.push($(v).text().trim());
    });
    const texto = versos.join('\n');

    const clave = etiqueta
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, '_');

    resultado[clave] = { cita, texto };
  });

  return resultado;
}

async function obtenerEvangelio(anio, mesNum, diaNum) {
  const fecha = `${anio}-${String(mesNum).padStart(2, '0')}-${String(diaNum).padStart(2, '0')}`;
  const url = `https://www.aciprensa.com/calendario/${fecha}`;

  const respuesta = await fetch(url);
  if (!respuesta.ok) return { evangelio: null, url, ok: false };

  const html = await respuesta.text();
  const secciones = parseAciprensa(html);
  return { evangelio: secciones.evangelio || null, url, ok: true };
}

// Endpoint para pruebas manuales con una fecha específica (no usa la
// caché de "hoy": siempre consulta las fuentes en vivo).
app.get('/api/lecturas/:anio/:mes/:dia', async (req, res) => {
  try {
    const { anio, mes, dia } = req.params;
    const mesNum = parseInt(mes, 10);
    const diaNum = parseInt(dia, 10);

    if (!mesNum || mesNum < 1 || mesNum > 12 || !diaNum) {
      return res.status(400).json({ error: 'Mes o día inválido' });
    }

    const datos = await construirDatosDelDia(anio, mesNum, diaNum);
    res.json(datos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Colombia no tiene horario de verano: siempre es UTC-5, todo el año.
const DESFASE_COLOMBIA_HORAS = 5;
const HORA_CORTE = 5; // a las 5:00am hora Colombia se considera "día nuevo" y se refresca la caché

function fechaLiturgicaColombia() {
  const ahoraUtc = new Date();
  const colombia = new Date(ahoraUtc.getTime() - DESFASE_COLOMBIA_HORAS * 60 * 60 * 1000);

  if (colombia.getUTCHours() < HORA_CORTE) {
    colombia.setUTCDate(colombia.getUTCDate() - 1);
  }

  return {
    anio: colombia.getUTCFullYear(),
    mes: colombia.getUTCMonth() + 1,
    dia: colombia.getUTCDate(),
  };
}

function claveFecha({ anio, mes, dia }) {
  return `${anio}-${mes}-${dia}`;
}

// ---------- Caché en memoria del servidor ----------
// El texto bíblico del día se guarda aquí una sola vez, y se sirve desde
// memoria en cada petición. Solo se vuelve a consultar a las 2 fuentes
// externas cuando cambia el día litúrgico (5am Colombia) o si el proceso
// se acaba de reiniciar (ej. Render "despertando" tras estar dormido).
let cacheHoy = {
  clave: null, // ej. "2026-7-28"
  datos: null, // el JSON de respuesta ya armado
};

async function construirDatosDelDia(anio, mesNum, diaNum) {
  const [oficio, evangelioData] = await Promise.all([
    obtenerOficio(anio, mesNum, diaNum),
    obtenerEvangelio(anio, mesNum, diaNum),
  ]);

  return {
    fecha: `${anio}-${String(mesNum).padStart(2, '0')}-${String(diaNum).padStart(2, '0')}`,
    url_oficio: oficio.url,
    url_evangelio: evangelioData.url,
    primera_lectura: oficio.secciones.primera_lectura || null,
    segunda_lectura: oficio.secciones.segunda_lectura || null,
    salmo: oficio.secciones.salmodia || null,
    evangelio: evangelioData.evangelio ? evangelioData.evangelio.texto : null,
    evangelio_cita: evangelioData.evangelio ? evangelioData.evangelio.cita : null,
  };
}

/// Actualiza la caché con las lecturas del día litúrgico actual.
/// Se llama: (a) al arrancar el servidor, (b) cada vez que el chequeo
/// periódico detecta que ya cambió el día (pasadas las 5am Colombia).
async function actualizarCacheDelDia() {
  const fecha = fechaLiturgicaColombia();
  const clave = claveFecha(fecha);
  console.log(`[cache] Actualizando lecturas para ${clave}...`);
  try {
    const datos = await construirDatosDelDia(fecha.anio, fecha.mes, fecha.dia);
    cacheHoy = { clave, datos };
    console.log(`[cache] Listo. Evangelio: ${datos.evangelio_cita || 'no encontrado'}`);
  } catch (error) {
    console.error('[cache] Error actualizando la caché:', error.message);
  }
}

// Revisa cada 5 minutos si ya cambió el día litúrgico; si es así, refresca.
// (Nota: en el plan gratuito de Render, el proceso se detiene por completo
// cuando nadie usa la API por un rato, así que este chequeo periódico solo
// corre mientras el servidor está despierto. Por eso el endpoint /hoy más
// abajo también sabe refrescar la caché por su cuenta si la nota vencida
// o vacía cuando llega una petición real.)
setInterval(() => {
  const claveActual = claveFecha(fechaLiturgicaColombia());
  if (claveActual !== cacheHoy.clave) {
    actualizarCacheDelDia();
  }
}, 60 * 60 * 1000); // 👈 antes era 5 * 60 * 1000 (5 min), ahora es 60 min

// Primera carga al arrancar el servidor
actualizarCacheDelDia();

app.get('/api/lecturas/hoy', async (req, res) => {
  try {
    const claveActual = claveFecha(fechaLiturgicaColombia());

    // Si la caché está vacía o es de un día anterior, se actualiza ahora
    // mismo (cubre el caso de que el servidor recién esté despertando).
    if (cacheHoy.clave !== claveActual || !cacheHoy.datos) {
      await actualizarCacheDelDia();
    }

    res.json(cacheHoy.datos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3.2 RUTA: Información litúrgica del día desde la tabla dias_liturgicos
app.get('/api/dia', async (req, res) => {
  try {
    // Hora Colombia = UTC-5, sin horario de verano
    const col = new Date(new Date().getTime() - 5 * 60 * 60 * 1000);
    const fechaHoy = `${col.getUTCFullYear()}-${String(col.getUTCMonth() + 1).padStart(2, '0')}-${String(col.getUTCDate()).padStart(2, '0')}`;
    const result = await pool.query(
      `SELECT fecha, dia_semana, titulo_fiesta, primera_lectura, salmo,
              segunda_lectura, evangelio, actualizado_en
       FROM dias_liturgicos WHERE fecha = $1`,
      [fechaHoy]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No hay información de hoy en la base de datos.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener la información del día' });
  }
});


app.listen(PORT, () => {
  console.log(`API corriendo en http://localhost:${PORT}`);
  console.log(`Prueba: http://localhost:${PORT}/api/lecturas/2026/7/28`);

  // 🔍 Auto-diagnóstico: prueba los endpoints apenas arranca el servidor.
  // Espera 3 segundos para dar tiempo a que la caché de lecturas se llene.
  setTimeout(autoDiagnostico, 3000);
});

async function autoDiagnostico() {
  const base = `http://localhost:${PORT}`;
  console.log('\n🔍 ---- INICIANDO AUTO-DIAGNÓSTICO ---- 🔍');

  const pruebas = [
    { nombre: 'Página principal', metodo: 'GET', url: `${base}/` },
    { nombre: 'Listar canciones', metodo: 'GET', url: `${base}/api/canciones` },
    { nombre: 'Lecturas de hoy', metodo: 'GET', url: `${base}/api/lecturas/hoy` },
    { nombre: 'Lecturas fecha fija (2026/7/28)', metodo: 'GET', url: `${base}/api/lecturas/2026/7/28` },
    { nombre: 'Mes inválido (debe dar 400)', metodo: 'GET', url: `${base}/api/lecturas/2026/13/28` },
  ];

  for (const prueba of pruebas) {
    try {
      const inicio = Date.now();
      const respuesta = await fetch(prueba.url, { method: prueba.metodo });
      const ms = Date.now() - inicio;

      // Si el nombre dice "debe dar", entonces ESPERAMOS que falle (ej. 400).
      // Si no lo dice, esperamos que responda OK (2xx).
      const esperabaFallo = prueba.nombre.includes('debe dar');
      const exito = esperabaFallo ? !respuesta.ok : respuesta.ok;
      const emoji = exito ? '✅' : '⚠️';

      console.log(`${emoji} [${respuesta.status}] ${prueba.nombre} (${ms}ms)`);

      // Solo muestra el detalle si el resultado NO fue el esperado
      if (!exito) {
        const texto = await respuesta.text();
        console.log(`   ↳ Detalle: ${texto.slice(0, 200)}`);
      }
    } catch (error) {
      console.log(`❌ [ERROR] ${prueba.nombre}: ${error.message}`);
    }
  }

  console.log('🔍 ---- AUTO-DIAGNÓSTICO TERMINADO ---- 🔍\n');
}

module.exports = pool;