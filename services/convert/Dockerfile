# Norbital Convert: pandoc + Typst (the pandoc/typst image) behind a Node 26 server.
FROM node:26-alpine AS node

FROM node AS dependencies
ARG PNPM_VERSION=11.22.0
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# pandoc's reference.docx with an A4 portrait section and the PDF's 1.25 in margins: pandoc's own has no page size.
FROM pandoc/typst:3.9 AS a4
RUN apk add --no-cache zip && mkdir /a4 && cd /a4 && pandoc -o a4.docx --print-default-data-file reference.docx \
	&& unzip -q a4.docx word/document.xml \
	&& sed -i 's|</w:footnotePr>|&<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1800" w:right="1800" w:bottom="1800" w:left="1800" w:header="720" w:footer="720" w:gutter="0"/>|' word/document.xml \
	&& grep -q 'w:w="11906"' word/document.xml && zip -q a4.docx word/document.xml

FROM pandoc/typst:3.9 AS runtime
# One CJK family (Noto Sans CJK, regular and bold) so Chinese in a PDF is not empty boxes; the Serif files go.
RUN apk add --no-cache libstdc++ libgcc libatomic tini font-noto-cjk \
	&& rm /usr/share/fonts/noto/NotoSerifCJK-* \
	&& addgroup -S -g 10001 convert && adduser -S -u 10001 -G convert convert \
	&& mkdir -p /var/lib/convert && chown convert:convert /var/lib/convert
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY package.json ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY src ./src
COPY --from=a4 /a4/a4.docx ./src/a4.docx
USER convert
ENV CONVERT_DATA=/var/lib/convert PORT=8080 NODE_ENV=production
VOLUME /var/lib/convert
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.ts"]

FROM dependencies AS test-dependencies
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM runtime AS test
COPY --from=test-dependencies /app/node_modules ./node_modules
COPY tests ./tests
CMD ["node", "node_modules/vitest/vitest.mjs", "run"]

FROM runtime AS final
