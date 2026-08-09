# Liturgia API ⛪

Backend de la aplicación **Parroquia San Ter de Jesús**: sirve las lecturas
litúrgicas del día (según el calendario de Colombia) y el cancionero, con un
panel de administración para gestionar las canciones.

---

## 🏗️ ¿Cómo está compuesto el proyecto?

```
APP FLUTTER (celular)
      │  HTTPS
      ▼
┌─────────────────────────────┐      ┌─────────────────────────────┐
│  SERVER1 (Render)           │      │  SERVER9 (local, tu PC)     │
│  API REST + Panel admin     │      │  Scraper de lecturas        │
│  HTML para las canciones    │      │  corre 1 vez al día         │
└──────────────┬──────────────┘      └──────────────┬──────────────┘
               │                                   │
               ▼                                   ▼
        ┌───────────────────────────────────────────────┐
        │   BASE DE DATOS PostgreSQL (NEON)             │
        │   tablas: canciones, dias_liturgicos          │
        └───────────────────────────────────────────────┘
```

**Dos partes:**

1. **Server1 — backend en la nube (Render).** API REST + un **panel de
   administración en HTML** para agregar, editar y eliminar las **canciones**
   del cancionero. Se conecta a la base de datos de **Neon**.
2. **Server9 — scraper local.** Corre en tu PC (no en la nube): cada día saca
   las **citas bíblicas del día según el calendario de Colombia** desde el
   sitio de Ordo Colombiano y las guarda en la misma base de datos de Neon.
   Se programa con el **Programador de Tareas de Windows** para que corra solo.

> La app Flutter nunca se conecta directo a la base de datos: solo consume la
> API de Server1. Por eso mover la base de datos no requiere tocar la app.

---

## 🎵 ¿Qué ofrece?

### Lecturas litúrgicas del día
Primera Lectura, Salmo Responsorial, Segunda Lectura (cuando aplica) y
Evangelio, con sus citas bíblicas, según el calendario litúrgico de Colombia.
La app las muestra a los fieles.

### Canciones
CRUD completo del cancionero: **título, artista, clase, URL de audio y letra**.
La app Flutter muestra el cancionero y el **panel de administración** permite
gestionarlo sin tocar la base de datos.

### Panel de administración (HTML)
Interfaz web protegida por inicio de sesión. Hay **dos roles**:

- **Superusuario** (tú, `raleortizb@gmail.com`): al entrar cae en `/superadmin`,
  donde puede **registrar usuarios** y elegir a qué secciones puede entrar cada
  uno. No puede ser editado ni eliminado.
- **Usuarios (admin)**: al entrar, si solo tienen permiso para **una** sección se
  les lleva directo a ella; si tienen permiso para varias (o ninguna), caen en
  `/home`, donde eligen con los botones **🎵 Cancionero** y **💬 Mensaje** (solo
  se muestran los que tienen habilitados). Si intentan abrir una sección sin
  permiso, reciben un 403.

| Página | Ruta | Quién entra |
|--------|------|-------------|
| Login | `/login` | Público |
| Gestión de usuarios | `/superadmin` | Superusuario |
| Página de inicio | `/home` | Usuarios con sesión |
| Cancionero | `/cancionero` | Permiso `cancionero` |
| Mensajes de la parroquia | `/mensajes` | Permiso `mensajes` (en construcción) |

**👉 Panel de administración:** 
https://liturgia-api-jfyu.onrender.com

---

## 🛠️ Tecnologías

| Tecnología | Uso |
|------------|-----|
| Node.js + Express | Servidor REST (Server1) |
| `pg` (node-postgres) | Conexión a PostgreSQL (Neon) |
| `cheerio` | Scraping de lecturas en Server1 (fuentes externas) |
| Puppeteer + Chromium | Scraping de Ordo Colombiano en Server9 (local) |
| PostgreSQL (Neon) | Persistencia de datos |

---

## 📡 Endpoints (Server1)

### Canciones
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/canciones` | Listar todas las canciones (público: la app Flutter la consume sin login) |
| POST | `/api/canciones` | Crear canción (`titulo`, `artista`, `url_audio` obligatorios; `clase`, `letra` opcionales). **Requiere login admin** |
| PUT | `/api/canciones/:id` | Actualizar canción. **Requiere login admin** |
| DELETE | `/api/canciones/:id` | Eliminar canción. **Requiere login admin** |

### Autenticación (panel admin)
| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/auth/login` | Iniciar sesión con `email` y `password`. Devuelve una cookie `httpOnly` (JWT, 8h) |
| POST | `/api/auth/logout` | Cerrar sesión (borra la cookie) |
| GET | `/api/auth/me` | Devuelve el administrador de la sesión actual (`email`, `rol`, `permisos`) o 401 |

### Gestión de usuarios (solo superusuario)
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/admin/usuarios` | Listar usuarios (sin contraseñas) |
| POST | `/api/admin/usuarios` | Crear usuario: `email`, `password` (mín. 6) y `permisos` (`["cancionero","mensajes"]`) |
| PUT | `/api/admin/usuarios/:id` | Editar `permisos` y/o `password` de un usuario |
| DELETE | `/api/admin/usuarios/:id` | Eliminar usuario (el superusuario está protegido) |

### Liturgia
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/dia` | Liturgia de hoy desde la base de datos (tabla `dias_liturgicos`). **404** si el scraper aún no guardó datos de hoy |
| GET | `/api/lecturas/hoy` | Lecturas de hoy scrapeadas en vivo desde fuentes externas |
| GET | `/api/lecturas/:anio/:mes/:dia` | Pruebas manuales con una fecha específica |

### Otros
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/` | Panel de administración (`public/admin.html`) |

### Server9 (solo local)
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/dia-liturgico/hoy` | Liturgia de hoy leída directo de la base de datos |

---

## 🗄️ Base de datos (Neon)

Servidor PostgreSQL en la nube (**Neon**). El servidor se conecta usando
`process.env.DATABASE_URL` (SSL requerido, ya configurado).

| Tabla | Descripción | Quién la llena |
|-------|-------------|----------------|
| `canciones` | Cancionero | Panel admin / API (se crea sola al arrancar Server1) |
| `dias_liturgicos` | Lecturas del día | Server9 (scraper local diario) |
| `admins` | Usuarios del panel admin (correo, contraseña cifrada, rol, permisos `['cancionero','mensajes']`) | Se crea y siembra el superusuario automáticamente al arrancar Server1 |

---

## 🚀 Despliegue y configuración

### Server1 en Render
- El servicio está conectado al repositorio de GitHub: cada push a `main`
  redeploya automáticamente.
- Variables de entorno (configuradas en el **Dashboard de Render**):
  | Variable | Descripción |
  |----------|-------------|
  | `DATABASE_URL` | Cadena de conexión a PostgreSQL de Neon |
  | `PORT` | Puerto del servidor (Render lo asigna solo) |
  | `JWT_SECRET` | Secreto para firmar la sesión del panel (¡cámbialo por uno propio en Render!) |
  | `ADMIN_EMAIL` | Correo del superusuario inicial (por defecto `raleortizb@gmail.com`) |
  | `ADMIN_PASSWORD` | Contraseña del superusuario inicial (solo se usa la primera vez para crearlo) |

> ⚠️ Al desplegar, el superusuario se crea automáticamente en la tabla `admins`
> la primera vez que el servidor arranca con `ADMIN_EMAIL`/`ADMIN_PASSWORD`
> configuradas. Si ya se creó, cambiar esas variables **no** cambia la
> contraseña existente: edítala directamente en la tabla `admins` de Neon (o
> borra el registro para que se cree de nuevo).

### Server9 en tu PC
- `npm install` y un `.env` con la **misma** `DATABASE_URL` de Neon.
- Primera vez / prueba manual:
  ```bash
  npm run actualizar
  ```
  Esto scrapea el día de hoy y lo guarda en `dias_liturgicos`.
- **Programar la ejecución diaria** con el Programador de Tareas de Windows:
  1. `Win+R` → `taskschd.msc` → **Crear tarea básica** → **Diaria**.
  2. Acción: *Iniciar un programa*:
     - Programa: ruta a `node.exe` (ej. `C:\Program Files\nodejs\node.exe`)
     - Argumentos: `scripts\actualizar-lecturas.js`
     - Iniciar en: la carpeta de Server9
  3. La PC debe estar encendida y con internet a esa hora.

> ⚠️ `.env` está en `.gitignore`: **no se sube al repositorio**. Render usa la
> variable que configures en su Dashboard, no la del `.env` local.

---

## 💻 Ejecución local

```bash
# Server1 (API + panel admin)
cd Server1
npm install
# crear .env con DATABASE_URL (Neon) y PORT
node server.js

# Server9 (scraper de lecturas)
cd Server9
npm install
# crear .env con la misma DATABASE_URL
npm run actualizar
```
