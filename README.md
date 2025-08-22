# Feasy Factura Backend

Servicio en Render para automatizar facturación con Puppeteer.

## Endpoints
- `/healthz` → responde `ok` para pruebas
- `/fill` → recibe `plan.payload` con datos de ticket/factura y llena el portal

## Deploy
1. Subir repo a GitHub
2. Crear Web Service en Render con Dockerfile
3. Usar la URL `https://<servicio>.onrender.com/fill` en Google Apps Script
