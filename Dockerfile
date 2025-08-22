# Imagen oficial de Puppeteer con Chromium incluido
FROM ghcr.io/puppeteer/puppeteer:22

# Menos permisos para seguridad
USER pptruser

WORKDIR /app
COPY --chown=pptruser:pptruser package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY --chown=pptruser:pptruser . .

EXPOSE 8080
CMD ["npm", "start"]
