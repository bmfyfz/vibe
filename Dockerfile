# A whole Vibe in one container: the API, the web app and the scheduler, on
# SQLite in a volume. It is `vibe serve`, compiled to one file.
#
#   docker build -t vibe .
#   docker run -p 127.0.0.1:7473:7473 -v vibe-data:/data vibe
#
# The first start prints the URL and the token that owns the new Vibe.

FROM oven/bun:1.4 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile
# Builds the web app, compiles the CLI, and puts the app's files beside it.
RUN bun run --filter @vibe/cli build

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin vibe \
  && mkdir /data && chown vibe:vibe /data
COPY --from=build /src/apps/cli/dist/vibe /opt/vibe/vibe
COPY --from=build /src/apps/cli/dist/web /opt/vibe/web
RUN ln -s /opt/vibe/vibe /usr/local/bin/vibe
USER vibe
WORKDIR /data
# The database, the attachments, and the operator's secret and owner's token it starts with.
VOLUME /data
# The handle of the person a new Vibe is made for. A container has no user of its own to name.
ENV VIBE_OWNER=admin
EXPOSE 7473
ENTRYPOINT ["vibe"]
# Every interface inside the container: which of the host's can reach it is for `-p` to say.
CMD ["serve", "--host", "0.0.0.0", "--dir", "/data"]
