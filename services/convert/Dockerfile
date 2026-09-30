# Norbital Convert: pandoc + Typst (the pandoc/typst image) behind a zero-dependency Node 26 server.
FROM node:26-alpine AS node

FROM pandoc/typst:3.9
RUN apk add --no-cache libstdc++ libgcc tini \
	&& addgroup -S -g 10001 convert && adduser -S -u 10001 -G convert convert \
	&& mkdir -p /var/lib/convert && chown convert:convert /var/lib/convert
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY tests ./tests
USER convert
ENV CONVERT_DATA=/var/lib/convert PORT=8080 NODE_ENV=production
VOLUME /var/lib/convert
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.ts"]
