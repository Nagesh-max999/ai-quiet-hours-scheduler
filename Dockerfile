# ---------- 1) Build the React frontend ----------
FROM node:22-alpine AS web
WORKDIR /build/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---------- 2) Python backend that also serves the built frontend ----------
FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ENV=production \
    PORT=8000
WORKDIR /srv

COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

COPY server/ server/
COPY --from=web /build/client/dist client/dist

WORKDIR /srv/server
EXPOSE 8000
# Render (and most hosts) inject $PORT; app/__main__.py binds 0.0.0.0:$PORT.
CMD ["python", "-m", "app"]
