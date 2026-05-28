FROM --platform=linux/amd64 node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY dist/ ./dist/

ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.js"]
