FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bot.mjs ./

CMD ["node", "bot.mjs"]
