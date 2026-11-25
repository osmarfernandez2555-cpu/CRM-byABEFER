# CRM WhatsApp (multi-celular)

Panel web para ver y responder los WhatsApp de varios celulares desde un solo lugar.

- Conectás cada celular escaneando un QR (o con código de vinculación), igual que WhatsApp Web.
- Ves todos los chats juntos o filtrados por celular, con no leídos y búsqueda.
- Respondés con texto, fotos, videos, documentos y **notas de voz grabadas desde el navegador**.
- Los audios se escuchan con velocidad **1× / 1.5× / 2×** (queda recordada) y se encadenan como en WhatsApp.
- **ARA**, la vendedora estrella de Tutu: un bot de IA que responde los chats, asesora, toma consignaciones y ventas, y agenda citas en el Polo 52.
- Todo en tiempo real (Socket.IO). Los datos quedan en una base SQLite dentro de un volumen.

## Archivos

- `server.js`: servidor web, API, login y tiempo real
- `wa.js`: conexión de los celulares con WhatsApp (Baileys), guardado de mensajes y envíos
- `db.js`: base de datos SQLite
- `media.js`: conversión de audio con ffmpeg (incluido, no hay que instalar nada)
- `credito.js`: calificación crediticia vía Ruthina (`/api/bot/calificar`)
- `stock.js`: lectura y búsqueda del stock de la web
- `skills.js`: habilidades de venta que vienen de fábrica
- `ara.js`: ARA (IA con Claude, herramientas para agendar citas, guardar clientes y pasar a un asesor)
- `public/index.html`: el dashboard

## Variables de entorno

- `PANEL_PASSWORD`: contraseña para entrar al panel (**obligatoria**)
- `DATA_DIR`: carpeta donde se guardan sesiones, base y archivos. En Railway: `/data`
- `SESSION_SECRET` (opcional): cualquier texto largo; si lo cambiás, se cierra la sesión del panel
- `GEMINI_API_KEY`: clave de Gemini. Si está, ARA responde con Gemini (elige sola el Flash más nuevo; se puede cambiar en ARA → General)
- `ANTHROPIC_API_KEY` (opcional): para que ARA responda con Claude
- `RUTHINA_BOT_KEY`: la misma clave que tiene Ruthina (compara-conejo). Con ella ARA califica clientes: pide el DNI, consulta los bancos en Ruthina y le dice al cliente si tiene crédito (nunca montos); si no califica, le pide otro DNI
- `GROQ_API_KEY`: para que ARA entienda los audios (Whisper en Groq; se transcriben y se ven en el panel). Alternativa: `OPENAI_API_KEY`
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

## ARA (bot de ventas)

Botón **ARA** en la barra izquierda:

- **General**: prender/apagar, modo prueba (solo responde a los números que pongas), en qué celulares trabaja, horario de citas.
- **Entrenamiento**: personalidad, forma de vender y todo lo que sabe (stock, financiación, consignación, promos). Nunca inventa lo que no esté en Conocimiento.
- **Stock**: ARA lee sola el stock de tutuautomotores.com (API pública de WooCommerce) cada 12 horas (configurable), busca autos según lo que pide el cliente, pasa el link y manda las fotos por WhatsApp.
- **Habilidades**: técnicas de venta que aplica en cada chat (descubrir la necesidad, manejo de objeciones, llevar a la cita, negociación, competencia, leer al cliente, referidos). Se prenden, apagan, editan y se pueden crear propias. Basadas en sales-skills de Craig Hewitt (ver `CREDITOS.md`).
- **Probar a ARA**: simulador para chatear con ella sin WhatsApp (no guarda nada).
- **Citas** y **Clientes**: lo que ARA agenda y los datos que va juntando.

Reglas automáticas:

- Si una persona escribe en un chat (desde el panel o el celular), ARA se calla en ese chat por las horas configuradas.
- Si el cliente pide un asesor o hay un reclamo, ARA lo deriva, se calla y avisa en el panel (🙋).
- En cada chat, el botón de arriba a la derecha pausa o reactiva a ARA.
- Nunca responde en grupos.
