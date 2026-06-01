FROM ubuntu:24.04

RUN apt-get update && \
    apt-get install -y libboost-all-dev zip curl && \
    rm -rf /var/lib/apt/lists/*

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY innoextract ./innoextract

RUN chmod +x innoextract

# Install dependencies and build, then clean bun cache
RUN bun install && bun run build

EXPOSE 3050

CMD ["/app/server"]
