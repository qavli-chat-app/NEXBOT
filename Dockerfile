FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

# Baileys dependencies may be fetched from Git repositories during npm install.
# The slim Node image does not include git by default.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
