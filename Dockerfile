# Obraz aplikacji Helpdesk
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Najpierw tylko package*.json - Docker zcache'uje instalację zależności
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

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
