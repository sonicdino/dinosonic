
FROM denoland/deno:latest AS builder

RUN apt-get update && \
    apt-get install -y ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

RUN deno task build

FROM debian:bookworm-slim

RUN apt-get update && \
    apt-get install -y ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/dist/dinosonic /app/dinosonic

EXPOSE 4100

CMD ["/app/dinosonic"]
