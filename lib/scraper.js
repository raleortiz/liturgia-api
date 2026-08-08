const puppeteer = require('puppeteer');
const { parseDiaLiturgico } = require('./parser');
const { parseLecturas } = require('./parserLecturas');
const cache = require('./cache');

const BASE_URL = 'https://web-ordo-colombiano.cec.org.co';
const ZONA_HORARIA = 'America/Bogota';

// Selectores candidatos para el banner verde de fecha en /inicio (fallback
// genérico si el carrusel Swiper/Ionic no aparece — ver encontrarBanner()).
const BANNER_SELECTORS = ['.fecha-hoy', '[class*="fecha"]', '[class*="banner"]', '.card-fecha'];

// Fecha de hoy en Colombia como "YYYY-MM-DD", sin importar en qué zona
// horaria esté corriendo el servidor (ej. Render corre en UTC).
function claveDelDiaColombia() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA }).format(new Date());
}

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // evita crashes en contenedores con /dev/shm chico (Render, Docker, etc.)
    ],
  });
}

async function prepararPagina(page) {
  // El sitio decide "qué día es hoy" con el reloj del navegador. Si no
  // fijamos esto, en un servidor con reloj UTC el sitio ya muestra el día
  // siguiente desde las 7pm hora Colombia (UTC = Colombia + 5h).
  await page.emulateTimezone(ZONA_HORARIA);

  await page.goto(`${BASE_URL}/inicio`, { waitUntil: 'networkidle2', timeout: 30000 });
  // El sitio persiste en localStorage el último mes/día visto. Lo limpiamos
  // y recargamos para asegurarnos de que "Hoy" en el banner sea el día real.
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
}

// Busca el elemento clickeable del banner de fecha.
// El banner en realidad es un carrusel Swiper/Ionic (ion-slides > ion-slide >
// ion-card), uno por día. Hay que apuntar al SLIDE ACTIVO, no a cualquier
// ion-card (el primero en el DOM puede ser un día distinto al visible).
async function encontrarBanner(page) {
  // 1) Slide activo con la clase estándar de Swiper.
  const activo = await page.$('ion-slide.swiper-slide-active ion-card');
  if (activo) return { handle: activo, selector: 'ion-slide.swiper-slide-active ion-card' };

  // 1b) Por si el nombre exacto de la clase "activa" varía entre versiones.
  const activoHandle = await page.evaluateHandle(() => {
    const slide = Array.from(document.querySelectorAll('ion-slide')).find((s) =>
      /active/i.test(s.className)
    );
    return slide ? slide.querySelector('ion-card') : null;
  });
  const elActivo = activoHandle.asElement();
  if (elActivo) return { handle: elActivo, selector: 'ion-slide[class*=active] ion-card' };

  // 2) Selectores CSS candidatos genéricos (fallback si no hay carrusel).
  for (const selector of BANNER_SELECTORS) {
    const handle = await page.$(selector);
    if (handle) return { handle, selector };
  }

  // 3) Último recurso: cualquier nodo pequeño cuyo texto tenga forma de
  // fecha, subiendo al ancestro clickeable más cercano.
  const handle = await page.evaluateHandle(() => {
    const meses = 'Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic';
    const patronFecha = new RegExp(`\\d{1,2}\\s+(${meses})`, 'i');

    const candidatos = Array.from(document.querySelectorAll('*')).filter(
      (el) => el.children.length < 6 && patronFecha.test(el.textContent || '')
    );
    candidatos.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    let nodo = candidatos[0] || null;
    if (!nodo) return null;

    let el = nodo;
    for (let i = 0; i < 6 && el; i++) {
      const style = window.getComputedStyle(el);
      const esClickeable =
        el.tagName === 'BUTTON' ||
        el.tagName === 'A' ||
        el.getAttribute('role') === 'button' ||
        el.hasAttribute('routerlink') ||
        style.cursor === 'pointer';
      if (esClickeable) return el;
      el = el.parentElement;
    }
    return nodo;
  });

  const el = handle.asElement();
  if (el) return { handle: el, selector: '(fallback por texto de fecha)' };
  return null;
}

// Hace clic con reintentos, re-consultando el DOM en cada intento (el handle
// puede quedar "stale" si Angular re-renderiza entre intentos). Prueba tres
// métodos distintos de clic, en orden, y reporta diagnóstico de cada uno.
// `verificarExito(page)` decide si el clic funcionó; por defecto, chequea que
// la URL haya cambiado a /detalle-dia-liturgico (útil para el banner). Para
// navegaciones a otra ruta (ej. "Lecturas del día"), pasar una verificación
// custom.
async function clickConReintentos(page, findFn, { maxAttempts = 5, verificarExito } = {}) {
  const verificar = verificarExito || (async () => page.url().includes('/detalle-dia-liturgico'));
  const log = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const encontrado = await findFn(page);
    if (!encontrado) {
      log.push({ attempt, error: 'elemento no encontrado en el DOM' });
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }

    const box = await encontrado.handle.boundingBox();
    if (!box) {
      log.push({ attempt, error: 'elemento encontrado pero sin boundingBox (oculto?)' });
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }

    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    const elementoEnPunto = await page.evaluate(
      (x, y) => {
        const el = document.elementFromPoint(x, y);
        return el ? el.outerHTML.slice(0, 200) : null;
      },
      x,
      y
    );

    // Método 1: mouse down/up con delay (simula mejor un clic humano que
    // page.mouse.click() directo).
    await page.mouse.move(x, y);
    await page.mouse.down();
    await new Promise((r) => setTimeout(r, 90));
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 500));
    if (await verificar(page)) {
      log.push({ attempt, metodo: 'mouse-down-up', selector: encontrado.selector, elementoEnPunto, resultado: 'ok' });
      return { ok: true, log };
    }

    // Método 2: foco + Enter, re-consultando el handle (no reusar el viejo).
    const encontrado2 = await findFn(page);
    if (encontrado2) {
      await encontrado2.handle.focus().catch(() => {});
      await page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 500));
      if (await verificar(page)) {
        log.push({ attempt, metodo: 'focus+Enter', selector: encontrado2.selector, elementoEnPunto, resultado: 'ok' });
        return { ok: true, log };
      }
    }

    // Método 3: clic sintético vía DOM (el.click()).
    const encontrado3 = await findFn(page);
    if (encontrado3) {
      await page.evaluate((el) => el.click(), encontrado3.handle);
      await new Promise((r) => setTimeout(r, 500));
      if (await verificar(page)) {
        log.push({ attempt, metodo: 'DOM el.click()', selector: encontrado3.selector, elementoEnPunto, resultado: 'ok' });
        return { ok: true, log };
      }
    }

    log.push({
      attempt,
      selector: encontrado.selector,
      elementoEnPunto,
      resultado: 'ningún método logró el efecto esperado',
    });
  }

  return { ok: false, log };
}

async function extraerTexto(page) {
  return page.evaluate(
    () => document.querySelector('app-root')?.innerText || document.body.innerText
  );
}

// Busca un elemento clickeable cuyo texto coincida (exacto o parcial) con
// `textoBuscado`, y sube hasta el ancestro clickeable más cercano — misma
// lógica que encontrarBanner, pero reutilizable para cualquier texto
// (ej: "Lecturas del día").
function crearBuscadorPorTexto(textoBuscado) {
  return async function (page) {
    const handle = await page.evaluateHandle((texto) => {
      const normalizar = (s) => (s || '').trim().toLowerCase();
      const objetivo = normalizar(texto);

      const candidatos = Array.from(document.querySelectorAll('*')).filter((el) => {
        if (el.children.length > 4) return false;
        return normalizar(el.textContent).includes(objetivo);
      });
      candidatos.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
      let nodo = candidatos[0] || null;
      if (!nodo) return null;

      let el = nodo;
      for (let i = 0; i < 6 && el; i++) {
        const style = window.getComputedStyle(el);
        const esClickeable =
          el.tagName === 'BUTTON' ||
          el.tagName === 'A' ||
          el.tagName === 'ION-ITEM' ||
          el.getAttribute('role') === 'button' ||
          el.hasAttribute('routerlink') ||
          style.cursor === 'pointer';
        if (esClickeable) return el;
        el = el.parentElement;
      }
      return nodo;
    }, textoBuscado);

    const el = handle.asElement();
    if (el) return { handle: el, selector: `(texto: "${textoBuscado}")` };
    return null;
  };
}

// Intenta ir a "Lecturas del día" desde /detalle-dia-liturgico. Esto navega
// a una página nueva (/lectura-dia), así que el éxito se mide por el cambio
// de URL (igual que con el banner).
async function clickLecturasDelDia(page) {
  const buscar = crearBuscadorPorTexto('Lecturas del día');
  const verificar = async () => page.url().includes('/lectura-dia');
  return clickConReintentos(page, buscar, { verificarExito: verificar, maxAttempts: 4 });
}

async function getHoy() {
  const cacheKey = 'hoy-' + claveDelDiaColombia();
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const respuestasConError = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('response', (response) => {
      if (response.status() >= 400) {
        respuestasConError.push({ url: response.url(), status: response.status() });
      }
    });

    await prepararPagina(page);

    const clic = await clickConReintentos(page, encontrarBanner);
    if (!clic.ok) {
      const err = new Error(
        'No se logró navegar a /detalle-dia-liturgico haciendo clic en el banner de fecha del sitio de Ordo Colombiano.'
      );
      err.diagnostico = { clic, consoleErrors, pageErrors, respuestasConError };
      throw err;
    }

    await page.waitForFunction(() => location.pathname.includes('detalle-dia-liturgico'), {
      timeout: 10000,
    });
    await new Promise((r) => setTimeout(r, 500)); // margen para que Angular termine de pintar

    const textoCrudoInicial = await extraerTexto(page);
    const urlDetalle = page.url();
    const infoDelDia = parseDiaLiturgico(textoCrudoInicial);

    // "Lecturas del día" navega a una página nueva (/lectura-dia). Ahí
    // parseamos directamente por encabezados (Primera lectura / Salmo /
    // Segunda lectura / Evangelio).
    const clicLecturas = await clickLecturasDelDia(page).catch((e) => ({ ok: false, error: e.message }));

    let lecturas = null;
    let urlLecturas = null;
    if (clicLecturas.ok) {
      await new Promise((r) => setTimeout(r, 400));
      const textoLecturas = await extraerTexto(page);
      lecturas = parseLecturas(textoLecturas);
      urlLecturas = page.url();
    }

    const resultado = {
      fecha: infoDelDia.fecha,
      diaSemana: infoDelDia.diaSemana,
      tituloFiesta: infoDelDia.tituloFiesta,
      primeraLectura: lecturas?.primeraLectura || null,
      salmo: lecturas?.salmo || null,
      segundaLectura: lecturas?.segundaLectura || null,
      evangelio: lecturas?.evangelio || null,
      _meta: {
        urlDetalle,
        urlLecturas,
        obtenidoEn: new Date().toISOString(),
        claveCache: cacheKey,
        metodoClicBanner: clic.log,
        lecturasExpandidas: clicLecturas.ok,
        metodoClicLecturas: clicLecturas.log || null,
      },
    };
    cache.set(cacheKey, resultado);
    return resultado;
  } finally {
    await browser.close();
  }
}

module.exports = { getHoy };