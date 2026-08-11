require('dotenv').config();

const express = require('express');
const cheerio = require('cheerio');
const cors = require('cors');
const { Pool } = require('pg'); // Mover arriba
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. CONFIGURACIÓN DEL CONFIG DE EXPRESS Y PERMISOS (DEBE IR PRIMERO)
app.use(cors());
app.use(express.json());
app.set('trust proxy', 1);

// 1.1 SEGURIDAD DEL PANEL ADMIN: LOGIN CON USUARIO (EMAIL) Y CONTRASEÑA
const JWT_SECRET = process.env.JWT_SECRET || 'cambia_este_secreto_en_render';
const NOMBRE_COOKIE = 'token_admin';

function obtenerCookie(req, nombre) {
  const raw = req.headers.cookie || '';
  const par = raw.split(';').map(c => c.trim()).find(c => c.startsWith(nombre + '='));
  return par ? decodeURIComponent(par.slice(nombre.length + 1)) : null;
}

function verificarToken(req) {
  const token = obtenerCookie(req, NOMBRE_COOKIE);
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

// Busca al admin actual en la base de datos (datos frescos: rol y permisos)
async function adminDeSesion(req) {
  const payload = verificarToken(req);
  if (!payload) return null;
  try {
    const result = await pool.query(
      'SELECT id, email, rol, permisos FROM admins WHERE id = $1',
      [payload.id]
    );
    return result.rows[0] || null;
  } catch (e) {
    return null;
  }
}

// Para páginas: si no hay sesión, manda al login
const requiereAuth = async (req, res, next) => {
  const admin = await adminDeSesion(req);
  if (!admin) return res.redirect('/login');
  req.admin = admin;
  next();
};

// Revisa que el usuario tenga un permiso concreto (o sea superusuario)
const requierePermiso = (permiso) => async (req, res, next) => {
  const admin = await adminDeSesion(req);
  if (!admin) return res.redirect('/login');
  if (admin.rol !== 'superadmin' && !(admin.permisos || []).includes(permiso)) {
    return res.status(403).send('No tienes permiso para acceder a esta sección.');
  }
  req.admin = admin;
  next();
};

// Para la API: exige sesión + un permiso concreto (responde JSON)
const requierePermisoApi = (permiso) => async (req, res, next) => {
  const admin = await adminDeSesion(req);
  if (!admin) return res.status(401).json({ error: 'No autorizado. Inicia sesión primero.' });
  if (admin.rol !== 'superadmin' && !(admin.permisos || []).includes(permiso)) {
    return res.status(403).json({ error: 'No tienes permiso para esta acción.' });
  }
  req.admin = admin;
  next();
};

// Solo el superusuario
const requiereSuperadmin = async (req, res, next) => {
  const admin = await adminDeSesion(req);
  if (!admin) return res.redirect('/login');
  if (admin.rol !== 'superadmin') {
    return res.status(403).send('Acceso restringido al superusuario.');
  }
  req.admin = admin;
  next();
};

// 📥 Redirige a la última release del APK en GitHub (con caché de 10 min)
const cacheApk = { url: null, ts: 0 };
const REPO_RELEASES = 'https://api.github.com/repos/raleortiz/liturgia-api/releases/latest';

async function obtenerUrlApk() {
  if (cacheApk.url && Date.now() - cacheApk.ts < 10 * 60 * 1000) return cacheApk.url;
  const respuesta = await fetch(REPO_RELEASES, { headers: { 'User-Agent': 'liturgia-server' } });
  if (!respuesta.ok) throw new Error('GitHub API error ' + respuesta.status);
  const data = await respuesta.json();
  const apk = (data.assets || []).find((a) => a.name.endsWith('.apk'));
  if (!apk) throw new Error('No hay APK en la última release');
  cacheApk.url = apk.browser_download_url;
  cacheApk.ts = Date.now();
  return apk.browser_download_url;
}

app.get('/descargar', async (req, res) => {
  try {
    const url = await obtenerUrlApk();
    res.redirect(url);
  } catch (e) {
    res.status(502).send('No se pudo obtener el enlace de descarga. Inténtalo más tarde.');
  }
});

// 📥 Página pública de descarga del APK (no requiere login)
app.get('/descarga', (req, res) => {
  res.sendFile(__dirname + '/public/descarga.html');
});

// 🚪 Página de login (pública)
app.get('/login', (req, res) => {
  if (verificarToken(req)) return res.redirect('/');
  res.sendFile(__dirname + '/public/login.html');
});

// 🔒 Bloquea el acceso directo a /admin.html (debe ir ANTES de express.static)
app.use('/admin.html', requierePermiso('cancionero'));

// 🛠️ Hace que la carpeta "public" sea accesible desde la web
app.use(express.static('public'));

// 🏠 Ruta principal: según el rol y los permisos, manda a la pantalla correcta
app.get('/', requiereAuth, (req, res) => {
  if (req.admin.rol === 'superadmin') return res.redirect('/superadmin');

  const permisos = req.admin.permisos || [];
  const puedeCancionero = permisos.includes('cancionero');
  const puedeMensajes = permisos.includes('mensajes');

  // Si solo tiene un permiso, se le lleva directo a esa pantalla
  if (puedeCancionero && !puedeMensajes) return res.redirect('/cancionero');
  if (puedeMensajes && !puedeCancionero) return res.redirect('/mensajes');

  // Con varios (o ninguno) se le pregunta a dónde quiere ir
  res.redirect('/home');
});

// 🏠 Página de inicio con los botones (Cancionero / Mensaje)
app.get('/home', requiereAuth, (req, res) => {
  res.sendFile(__dirname + '/public/home.html');
});

// 🎵 Cancionero (gestión de canciones) - requiere permiso
app.get('/cancionero', requierePermiso('cancionero'), (req, res) => {
  res.sendFile(__dirname + '/public/admin.html');
});

// 💬 Mensajes de la parroquia - requiere permiso
app.get('/mensajes', requierePermiso('mensajes'), (req, res) => {
  res.sendFile(__dirname + '/public/mensajes.html');
});

// 👤 Gestión de usuarios - solo superusuario
app.get('/superadmin', requiereSuperadmin, (req, res) => {
  res.sendFile(__dirname + '/public/gestion.html');
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

// 2.1 ENDPOINTS DE AUTENTICACIÓN (LOGIN / LOGOUT / SESIÓN)
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'El correo y la contraseña son obligatorios.' });
  }
  try {
    const result = await pool.query(
      'SELECT * FROM admins WHERE LOWER(email) = LOWER($1)',
      [String(email).trim()]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
    }

    const admin = result.rows[0];
    const valida = bcrypt.compareSync(password, admin.password_hash);
    if (!valida) {
      return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
    }

    const token = jwt.sign(
      { id: admin.id, email: admin.email, rol: admin.rol },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    const esSeguro = req.secure || process.env.COOKIE_SECURE === 'true';
    res.cookie(NOMBRE_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: esSeguro,
      maxAge: 8 * 60 * 60 * 1000
    });
    res.json({ ok: true, email: admin.email, rol: admin.rol });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al iniciar sesión.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(NOMBRE_COOKIE);
  res.json({ ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  const admin = await adminDeSesion(req);
  if (!admin) return res.status(401).json({ error: 'No autorizado' });
  res.json({ email: admin.email, rol: admin.rol, permisos: admin.permisos || [] });
});

// 2.2 GESTIÓN DE USUARIOS (SOLO SUPERUSUARIO)
const PERMISOS_VALIDOS = ['cancionero', 'mensajes'];

app.get('/api/admin/usuarios', requiereSuperadmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, rol, permisos, created_at FROM admins ORDER BY id ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar los usuarios.' });
  }
});

app.post('/api/admin/usuarios', requiereSuperadmin, async (req, res) => {
  const { email, password, permisos } = req.body;
  const emailLimpio = String(email || '').trim().toLowerCase();
  if (!emailLimpio || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLimpio)) {
    return res.status(400).json({ error: 'Correo no válido.' });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
  }
  const permisosFiltrados = (Array.isArray(permisos) ? permisos : [])
    .filter(p => PERMISOS_VALIDOS.includes(p));
  try {
    const hash = bcrypt.hashSync(String(password), 10);
    const result = await pool.query(
      'INSERT INTO admins (email, password_hash, rol, permisos) VALUES ($1, $2, $3, $4) RETURNING id, email, rol, permisos, created_at',
      [emailLimpio, hash, 'admin', permisosFiltrados]
    );
    res.status(201).json({ message: 'Usuario creado.', usuario: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Ese correo ya está registrado.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error al crear el usuario.' });
  }
});

app.put('/api/admin/usuarios/:id', requiereSuperadmin, async (req, res) => {
  const { id } = req.params;
  const { permisos, password } = req.body;
  try {
    const existe = await pool.query('SELECT rol FROM admins WHERE id = $1', [id]);
    if (existe.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }
    if (existe.rows[0].rol === 'superadmin') {
      return res.status(400).json({ error: 'El superusuario no se puede editar desde aquí.' });
    }
    const permisosFiltrados = (Array.isArray(permisos) ? permisos : [])
      .filter(p => PERMISOS_VALIDOS.includes(p));
    if (password) {
      if (String(password).length < 6) {
        return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
      }
      const hash = bcrypt.hashSync(String(password), 10);
      await pool.query(
        'UPDATE admins SET permisos = $1, password_hash = $2 WHERE id = $3',
        [permisosFiltrados, hash, id]
      );
    } else {
      await pool.query(
        'UPDATE admins SET permisos = $1 WHERE id = $2',
        [permisosFiltrados, id]
      );
    }
    res.json({ message: 'Usuario actualizado.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar el usuario.' });
  }
});

app.delete('/api/admin/usuarios/:id', requiereSuperadmin, async (req, res) => {
  const { id } = req.params;
  try {
    const existe = await pool.query('SELECT id, rol FROM admins WHERE id = $1', [id]);
    if (existe.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }
    if (existe.rows[0].rol === 'superadmin') {
      return res.status(400).json({ error: 'El superusuario no se puede eliminar.' });
    }
    if (String(existe.rows[0].id) === String(req.admin.id)) {
      return res.status(400).json({ error: 'No puedes eliminarte a ti mismo.' });
    }
    await pool.query('DELETE FROM admins WHERE id = $1', [id]);
    res.json({ message: 'Usuario eliminado.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar el usuario.' });
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

app.post('/api/canciones', requierePermisoApi('cancionero'), async (req, res) => {
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

app.delete('/api/canciones/:id', requierePermisoApi('cancionero'), async (req, res) => {
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
app.put('/api/canciones/:id', requierePermisoApi('cancionero'), async (req, res) => {
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

// 4.1 TABLA DE ADMINISTRADORES (LOGIN DEL PANEL)
const inicializarTablaAdmins = async () => {
  const querySQL = `
    CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        rol VARCHAR(50) NOT NULL DEFAULT 'admin',
        permisos TEXT[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  try {
    await pool.query(querySQL);
    // Columna de permisos por si la tabla ya existía sin ella
    await pool.query("ALTER TABLE admins ADD COLUMN IF NOT EXISTS permisos TEXT[] NOT NULL DEFAULT '{}';");

    // Primer superusuario (solo se crea si no existe)
    const emailAdmin = (process.env.ADMIN_EMAIL || 'raleortizb@gmail.com').trim().toLowerCase();
    const passwordAdmin = process.env.ADMIN_PASSWORD || 'Aleo@94370733';
    const existe = await pool.query('SELECT id, permisos FROM admins WHERE LOWER(email) = LOWER($1)', [emailAdmin]);
    if (existe.rows.length === 0) {
      const hash = bcrypt.hashSync(passwordAdmin, 10);
      await pool.query(
        'INSERT INTO admins (email, password_hash, rol, permisos) VALUES ($1, $2, $3, $4)',
        [emailAdmin, hash, 'superadmin', ['cancionero', 'mensajes']]
      );
      console.log(`✅ Superusuario creado: ${emailAdmin}`);
    } else {
      // Asegura que el superusuario siempre tenga acceso a todo
      await pool.query(
        "UPDATE admins SET permisos = ARRAY['cancionero','mensajes'] WHERE id = $1 AND rol = 'superadmin' AND NOT (permisos @> ARRAY['cancionero','mensajes'])",
        [existe.rows[0].id]
      );
      console.log('✅ Tabla de administradores verificada.');
    }
  } catch (err) {
    console.error('❌ Error al inicializar la tabla de administradores:', err);
  }
};

inicializarTablaAdmins();

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
    // El mismo corte de 5:00am que usa la caché: antes de las 5 de la
    // mañana hora Colombia todavía se considera "ayer", así un usuario que
    // abre la app de madrugada ve las lecturas del día litúrgico actual
    // (que sí están guardadas) en vez de un 404 por "hoy" aún sin publicar.
    const { anio, mes, dia } = fechaLiturgicaColombia();
    const fechaHoy = `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
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