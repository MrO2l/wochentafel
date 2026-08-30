FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Abhaengigkeiten zuerst: bleibt im Build-Cache, solange sich package.json nicht aendert
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# Rezeptbilder-Upload-Verzeichnis (AP-ART3MIS, Wochenplaner-Rezeptkarten):
# als Pfad in dieser Alpine-Basis MUSS er exakt mit dem Default aus
# docker-compose.yml (RECIPE_IMAGES_DIR) uebereinstimmen -- Docker uebernimmt
# beim allerersten Mount eines LEEREN Named Volumes den Inhalt UND die
# Besitzrechte des im Image bereits vorhandenen Verzeichnisses an genau
# diesem Pfad ("Volume-Seeding"). Ohne dieses vorab angelegte, dem Nicht-
# root-User "node" gehoerende Verzeichnis wuerde das frische Volume mit
# root:root/0755 erstellt und der App-Prozess (laeuft als "node", siehe
# unten) koennte keine Bilder hochladen (EACCES) -- besonders relevant, weil
# der Container mit read_only:true faehrt (siehe docker-compose.yml) und
# dieses Volume der EINZIGE beschreibbare, persistente Pfad ausserhalb von
# /tmp (tmpfs, nicht persistent) ist.
# WICHTIG: Wird RECIPE_IMAGES_DIR in docker-compose.yml/.env auf einen
# ANDEREN Pfad geaendert, muss diese Zeile (und der COPY-Build) entsprechend
# angepasst werden, sonst schlaegt der Upload fehl.
RUN mkdir -p /data/recipe-images && chown -R node:node /data/recipe-images

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
