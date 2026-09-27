FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
RUN npm run build
ENV PORT=8102
EXPOSE 8102
CMD ["node", "dist/server.js"]
