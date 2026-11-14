# Playwright's Chromium and the Playwright npm package must use the same version.
FROM mcr.microsoft.com/playwright:v1.56.1-noble

ENV CI=1
WORKDIR /workspace

# Install browser-test dependencies separately so the app manifest is untouched.
COPY tests/e2e/package.json ./tests/e2e/package.json
RUN cd tests/e2e && npm install --no-audit --no-fund

# The existing application's package.json is required (lockfile is optional).
COPY frontend/app/package*.json ./frontend/app/
RUN cd frontend/app && npm install --no-audit --no-fund

COPY frontend/app/ ./frontend/app/
COPY tests/e2e/ ./tests/e2e/
RUN cd frontend/app && npm run build

CMD ["node", "--test", "tests/e2e/qr-transfer.e2e.mjs"]
