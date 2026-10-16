FROM node:20-slim
WORKDIR /app
COPY package*.json ./
# better-sqlite3 baixa um binário pré-compilado para essa plataforma (node:20-slim
# é Debian/glibc) — não precisa de build-essential/python no container.
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public
# data/ e uploads/ vêm de volumes externos (ver docker-compose.yml), não do build.
EXPOSE 3010
CMD ["node", "server.js"]
