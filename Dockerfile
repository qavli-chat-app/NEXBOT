FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

# Install dependencies separately for better layer caching and clearer build errors.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
ENV PORT=3000
EXPOSE 3000

# Railway sends SIGTERM during restarts; Node handles this through the runtime.
CMD ["npm", "start"]
