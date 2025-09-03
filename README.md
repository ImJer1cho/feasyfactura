# FeasyFactura (completo) — 2025-09-03

## Estructura
```
backend/        # Express + Puppeteer (Render)
apps-script/    # Google Apps Script (Gmail + Drive + OpenAI)
```

## Backend (Render)
- Dockerfile listo (imagen oficial de Puppeteer)
- Endpoints:
  - `GET /healthz` → ok
  - `POST /fill`  → ejecuta el plan AUTO_FORM, devuelve evidencia y (si hay) factura PDF
- Deploy: conecta el repo a Render como Web Service (Docker). Healthcheck: `/healthz`.

## Apps Script
1. Crea proyecto en https://script.google.com e importa `apps-script/Code.gs` y `appsscript.json`.
2. En **Script properties** agrega:
   - `OPENAI_API_KEY`
   - `ROOT_FOLDER_ID`
   - `TO_ADDRESS` (p.ej. daniel@mindandcreation.tech)
   - `SUBJECT_FILTER` (p.ej. feasy factura)
   - `MODEL` (p.ej. gpt-4o)
   - `PUPPETEER_WEBHOOK_URL` (https://tu-render.onrender.com/fill)
   - Datos fiscales receptor: `RECEPTOR_RFC`, `RECEPTOR_RAZON`, `RECEPTOR_CORREO`
   - (opcionales) domicilio: `RECEPTOR_CP`, `RECEPTOR_CALLE`, `RECEPTOR_NUMEXT`, `RECEPTOR_COLONIA`, `RECEPTOR_MUNICIPIO`, `RECEPTOR_ESTADO`
3. Corre `instalarTrigger()` o `testOnce()`.

## Flujo
Gmail → guarda adjuntos en Drive → OpenAI (Responses API, json_schema) → decide plan (AUTO_FORM o MANUAL_LINK) → llama backend → envía confirmación con artefactos.

## Notas
- Si el portal detecta CAPTCHA, hay fallback a **MANUAL_LINK** y se adjunta evidencia.
- Puedes ajustar sinónimos de inputs en `server.js` (función `synonymsFor`).

¡Listo para subir a GitHub y desplegar! 🚀
