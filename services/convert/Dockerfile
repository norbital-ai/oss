# Norbital Convert: pandoc + Typst (the pandoc/typst image), pdf.js and Kreuzberg (@kreuzberg/node) behind a Node 26
# server. Ubuntu 24.04, not Alpine: Kreuzberg's prebuilt binding is a glibc build.
FROM node:26-bookworm-slim AS node

FROM node AS dependencies
ARG PNPM_VERSION=11.22.0
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# pdf.js reads text, paths and pictures without its optional canvas.
RUN pnpm install --prod --frozen-lockfile --ignore-scripts && rm -rf /app/node_modules/.pnpm/@napi-rs+canvas*

# pandoc's reference.docx with an A4 portrait section and the PDF's 1.25 in margins: pandoc's own has no page size.
FROM pandoc/typst:3.9-ubuntu AS a4
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends zip unzip && mkdir /a4 && cd /a4 \
	&& pandoc -o a4.docx --print-default-data-file reference.docx \
	&& unzip -q a4.docx word/document.xml \
	&& sed -i 's|</w:footnotePr>|&<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1800" w:right="1800" w:bottom="1800" w:left="1800" w:header="720" w:footer="720" w:gutter="0"/>|' word/document.xml \
	&& grep -q 'w:w="11906"' word/document.xml && zip -q a4.docx word/document.xml

FROM pandoc/typst:3.9-ubuntu AS runtime
# One CJK family (Noto Sans CJK, regular and bold) so Chinese in a PDF is not empty boxes; the Serif files go.
# ffmpeg normalises audio for transcription, and ffprobe finds a video track.
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends tini fonts-noto-cjk ffmpeg \
	&& rm -rf /var/lib/apt/lists/* /usr/share/fonts/opentype/noto/NotoSerifCJK-* \
	&& groupadd -r -g 10001 convert && useradd -r -u 10001 -g convert convert \
	&& mkdir -p /var/lib/convert && chown convert:convert /var/lib/convert
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY package.json ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY src ./src
COPY --from=a4 /a4/a4.docx ./src/a4.docx
# No OCR package and no OCR language data or model on disk (the published binding has OCR code compiled in; the
# service never asks for it, which tests/ingest.test.ts proves).
RUN ! dpkg-query -W -f '${Package}\n' | grep -Ei 'tesseract|leptonica|liblept|paddle|easyocr|ocrad|cuneiform|gocr' \
	&& ! find / -xdev \( -iname '*tesseract*' -o -iname '*tessdata*' -o -iname 'liblept*' -o -iname '*paddle*' \
		-o -iname '*easyocr*' -o -iname '*.traineddata' -o -iname '*.onnx' \) -print | grep .
USER convert
ENV CONVERT_DATA=/var/lib/convert PORT=8080 NODE_ENV=production
VOLUME /var/lib/convert
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.ts"]

FROM dependencies AS test-dependencies
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM runtime AS test
USER root
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends poppler-utils unzip && rm -rf /var/lib/apt/lists/*
COPY --from=test-dependencies /app/node_modules ./node_modules
COPY tests ./tests
COPY tsconfig.json ./
# Vitest writes its API token and cache under node_modules.
RUN mkdir node_modules/.vitest node_modules/.vitest-cache && chown convert:convert node_modules/.vitest node_modules/.vitest-cache
USER convert
CMD ["node", "node_modules/vitest/vitest.mjs", "run"]

FROM runtime AS final
