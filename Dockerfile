# Obraz aplikacji Helpdesk
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Poprawki bezpieczeństwa pakietów systemu Alpine
RUN apk upgrade --no-cache

# Najpierw tylko package*.json - Docker zcache'uje instalację zależności
COPY package.json package-lock.json ./
# Po instalacji usuwamy npm, npx, corepack i yarn - aplikacja ich nie potrzebuje,
# a każde zbędne narzędzie w obrazie to dodatkowe podatności i możliwości dla atakującego
RUN npm ci --omit=dev && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
              /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
              /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY src ./src
COPY db ./db
COPY scripts ./scripts

# Pliki należą do roota, a użytkownik "node" może je tylko czytać.
# Dzięki temu nawet przejęta aplikacja nie zmodyfikuje własnego kodu.
RUN chmod -R a+rX /app

# Aplikacja nie działa jako root
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/health || exit 1

# Najpierw inicjalizacja bazy, potem serwer ("exec", żeby Node dostawał sygnały stop)
CMD ["sh", "-c", "node scripts/init-db.js && exec node src/server.js"]
