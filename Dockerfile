FROM --platform=linux/amd64 oven/bun:1 AS build

RUN apt-get update && \
    apt-get install -y zip && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
RUN bun install

COPY src ./src

RUN bun build --compile --minify-whitespace --minify-syntax --outfile server src/index.ts

FROM --platform=linux/amd64 debian:bookworm-slim AS runtime

RUN apt-get update && \
    apt-get install -y zip curl libboost-iostreams-dev && \
    rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash appuser

WORKDIR /app

COPY innoextract ./innoextract
RUN chmod +x innoextract

COPY --from=build /app/server ./server

RUN chown -R appuser:appuser /app

USER appuser

EXPOSE 3050

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3050/ || exit 1

CMD ["./server"]
