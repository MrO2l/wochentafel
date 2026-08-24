FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Abhaengigkeiten zuerst: bleibt im Build-Cache, solange sich package.json nicht aendert
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
