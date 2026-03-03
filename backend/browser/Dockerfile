FROM node:22-slim

# Playwright system deps
RUN npx playwright@1.50.1 install-deps chromium

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
# Install Playwright browser binary
RUN npx playwright install chromium

COPY server.js ./

EXPOSE 3334

CMD ["node", "server.js"]
