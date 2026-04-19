# Paragon Lookup — production image
# The Playwright image ships with Chromium + all browser deps already baked in.
# We pin the Playwright image version to match the npm dep in package.json.
FROM mcr.microsoft.com/playwright:v1.48.2-jammy

WORKDIR /app

# Install deps first so the layer caches.
COPY package*.json ./
# If package-lock.json is missing (common in a freshly scaffolded project),
# fall back to `npm install`. `npm ci` is preferred once the lockfile exists.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# Copy the app.
COPY . .

# SQLite file lives under /app/data (mounted as a Docker volume).
RUN mkdir -p /app/data

EXPOSE 3000

# The Playwright image runs as root by default; Dokploy handles its own user.
CMD ["node", "server.js"]
