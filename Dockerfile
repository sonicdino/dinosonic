
FROM denoland/deno:alpine AS builder

WORKDIR /app

COPY . .

RUN deno task build

FROM frolvlad/alpine-glibc:latest

RUN apk add --no-cache ffmpeg mpv

WORKDIR /app
COPY --from=builder /app/dist/dinosonic /app/dinosonic

EXPOSE 4100

CMD ["/app/dinosonic"]
