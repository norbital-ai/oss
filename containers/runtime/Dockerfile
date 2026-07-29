# syntax=docker/dockerfile:1.12
FROM node:26-alpine

ARG SOURCE_REVISION=unknown

LABEL org.opencontainers.image.title="Norbital tenant runtime" \
	org.opencontainers.image.description="Minimal runtime for an immutable tenant build bundle" \
	org.opencontainers.image.revision="${SOURCE_REVISION}"

ENV NODE_ENV=production

RUN mkdir -p /app && chown node:node /app

USER node
WORKDIR /app
ENTRYPOINT []
CMD ["node", "/app/serve.mjs"]
