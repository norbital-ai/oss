# Norbital Convert behind a Node 26 server: pandoc + Typst (from the pandoc/typst image) write; MuPDF and Poppler read PDFs,
# office_oxide and LibreOffice documents and slides, Calamine sheets. Ubuntu 26.04: its Poppler and MuPDF are current.
FROM node:26-bookworm-slim AS node

FROM node AS dependencies
ARG PNPM_VERSION=11.22.0
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# pandoc's reference.docx with an A4 portrait section and the PDF's 1.25 in margins: pandoc's own has no page size.
FROM pandoc/typst:3.9-ubuntu AS a4
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends zip unzip && mkdir /a4 && cd /a4 \
	&& pandoc -o a4.docx --print-default-data-file reference.docx \
	&& unzip -q a4.docx word/document.xml \
	&& sed -i 's|</w:footnotePr>|&<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1800" w:right="1800" w:bottom="1800" w:left="1800" w:header="720" w:footer="720" w:gutter="0"/>|' word/document.xml \
	&& grep -q 'w:w="11906"' word/document.xml && zip -q a4.docx word/document.xml

# office_oxide's released program, by architecture and digest.
FROM node AS office-oxide
ARG OFFICE_OXIDE=0.1.16
RUN set -e; case "$(uname -m)" in \
		aarch64) arch=aarch64 sum=a906dd318cad572bf72078e6fc5ba01e87f6edfad05900393ec0f7278e2d3975 ;; \
		x86_64) arch=x86_64 sum=4b250294ebe830085641c62dd0fa21b5e555145dbeb542371f43050470389494 ;; \
	esac; \
	node -e "fetch(process.argv[1]).then((r) => r.arrayBuffer()).then((b) => require('fs').writeFileSync('o.tgz', Buffer.from(b)))" \
		"https://github.com/yfedoseev/office_oxide/releases/download/v$OFFICE_OXIDE/office_oxide-linux-$arch-$OFFICE_OXIDE.tar.gz"; \
	echo "$sum  o.tgz" | sha256sum -c -; tar xzf o.tgz ./office-oxide

FROM ubuntu:26.04 AS runtime
# One CJK family (Noto Sans CJK, regular and bold) so Chinese in a PDF is not empty boxes; the Serif files go.
# ffmpeg normalises audio for transcription, and ffprobe finds a video track. MuPDF and Poppler read PDFs.
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends tini fonts-noto-cjk fonts-dejavu-core ffmpeg \
		poppler-utils poppler-data mupdf-tools libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
		ca-certificates liblua5.4-0 libgmp10 \
	&& rm -rf /var/lib/apt/lists/* /usr/share/fonts/opentype/noto/NotoSerifCJK-* \
	&& groupadd -r -g 10001 convert && useradd -r -u 10001 -g convert convert \
	&& mkdir -p /var/lib/convert && chown convert:convert /var/lib/convert
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=a4 /usr/local/bin/pandoc /usr/local/bin/typst /usr/local/bin/
COPY --from=office-oxide office-oxide /usr/local/bin/
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
# Every job is a process, so each starts from the compile cache rather than parsing the source again.
ENV CONVERT_DATA=/var/lib/convert PORT=8080 NODE_ENV=production NODE_COMPILE_CACHE=/tmp/convert-compile
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
