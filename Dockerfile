# ─── Stage 1: Build ────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app
COPY backend/package*.json ./
RUN npm install --omit=dev

# ─── Stage 2: Runtime ──────────────────────────────────────────────────────
FROM node:20-alpine

# ffmpeg for WAV conversion at upload time (resample to 8kHz mono)
# tini for proper PID1 signal handling
RUN apk add --no-cache \
    ffmpeg \
    tini

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY backend/ ./
COPY frontend/ ../frontend/

RUN mkdir -p /captures /wavfiles

ENV PORT=3000
ENV SIP_PORT=5060
ENV RTP_PORT_LOW=10000
ENV RTP_PORT_HIGH=20000
ENV CAPTURE_INTERFACE=any
ENV NODE_ENV=production

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
