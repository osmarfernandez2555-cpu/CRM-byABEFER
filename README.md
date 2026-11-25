# CRM WhatsApp (multi-celular)

Panel web para ver y responder los WhatsApp de varios celulares desde un solo lugar.

- Conectás cada celular escaneando un QR (o con código de vinculación), igual que WhatsApp Web.
- Ves todos los chats juntos o filtrados por celular, con no leídos y búsqueda.
- Respondés con texto, fotos, videos, documentos y **notas de voz grabadas desde el navegador**.
- Los audios se escuchan con velocidad **1× / 1.5× / 2×** (queda recordada) y se encadenan como en WhatsApp.
- Todo en tiempo real (Socket.IO). Los datos quedan en una base SQLite dentro de un volumen.

## Archivos

- `server.js`: servidor web, API, login y tiempo real
- `wa.js`: conexión de los celulares con WhatsApp (Baileys), guardado de mensajes y envíos
- `db.js`: base de datos SQLite
- `media.js`: conversión de audio con ffmpeg (incluido, no hay que instalar nada)
- `public/index.html`: el dashboard

## Variables de entorno

- `PANEL_PASSWORD`: contraseña para entrar al panel (**obligatoria**)
- `DATA_DIR`: carpeta donde se guardan sesiones, base y archivos. En Railway: `/data`
- `SESSION_SECRET` (opcional): cualquier texto largo; si lo cambiás, se cierra la sesión del panel
- `WA_LOG_LEVEL` (opcional): `warn` por defecto; `debug` para ver todo

## Probar en la PC

```bash
npm install
PANEL_PASSWORD=algo123 npm start
```

Abrí http://localhost:3000

## Subir a Railway

1. Subí esta carpeta a un repo nuevo de GitHub (por ejemplo `crm-whatsapp`).
2. Railway → **New Project** → **Deploy from GitHub repo** → elegí el repo.
3. En el servicio → **Variables**: `PANEL_PASSWORD` y `DATA_DIR=/data`.
4. En el servicio → clic derecho / **Attach Volume** → mount path: `/data`. (Sin volumen, cada deploy borra los celulares vinculados.)
5. **Settings → Networking → Generate Domain**.
6. Entrá al dominio, poné la contraseña y conectá el primer celular con el **+**.
