FROM node:26.8.1-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e

# Supply an exact reviewed release (including an exact alpha version if required).
# No mutable tag is accepted. Record the resulting image digest in deployment config.
ARG CODEX_VERSION
RUN test -n "$CODEX_VERSION" \
    && printf '%s' "$CODEX_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$' \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@openai/codex@$CODEX_VERSION" \
    && codex exec-server --help >/dev/null \
    && useradd --uid 10001 --create-home codex
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["codex"]
