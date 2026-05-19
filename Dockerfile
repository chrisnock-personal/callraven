# ─── Stage 1: Node deps ────────────────────────────────────────────────────
FROM node:20-alpine AS node-builder
WORKDIR /app
COPY backend/package*.json ./
RUN npm install --omit=dev

# ─── Stage 2: Build whisper.cpp (static) ───────────────────────────────────
FROM alpine:3.19 AS whisper-builder
RUN apk add --no-cache \
    build-base \
    cmake \
    git \
    wget \
    sdl2-dev

RUN git clone --depth=1 https://github.com/ggerganov/whisper.cpp /whisper
WORKDIR /whisper

# Build fully static so no .so deps needed in runtime image
RUN cmake -B build \
      -DWHISPER_BUILD_TESTS=OFF \
      -DWHISPER_BUILD_EXAMPLES=ON \
      -DBUILD_SHARED_LIBS=OFF \
      -DGGML_STATIC=ON \
      -DCMAKE_EXE_LINKER_FLAGS="-static" \
    && cmake --build build --config Release -j$(nproc) \
    && cp build/bin/whisper-cli /usr/local/bin/whisper-cli

# Download ggml-small.en model (~465MB)
RUN mkdir -p /models && \
    wget -q -O /models/ggml-small.en.bin \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin"

# ─── Stage 3: Runtime ──────────────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache \
    ffmpeg \
    tini

WORKDIR /app

COPY --from=node-builder /app/node_modules ./node_modules
COPY --from=whisper-builder /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper-builder /models /models

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
