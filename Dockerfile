FROM node:22-slim

# Install Chromium's RUNTIME LIBS only — NOT the `chromium` package itself.
# Puppeteer downloads its OWN version-matched Chromium (see npm install below);
# Debian's `chromium` drifted ahead of puppeteer's pinned build, causing the
# "Protocol error (Target.closeTarget): No target with given id found" crash.
# Letting puppeteer manage the browser keeps the DevTools protocol in lockstep.
RUN apt-get update && apt-get install -y \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Puppeteer downloads + manages its own version-matched Chromium during
# `npm install` (cached under /root/.cache/puppeteer). Do NOT set
# PUPPETEER_SKIP_CHROMIUM_DOWNLOAD or PUPPETEER_EXECUTABLE_PATH — letting
# puppeteer.launch() pick its bundled browser is what fixes the protocol
# mismatch. (server.js falls back to puppeteer's default when the env is unset.)

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
