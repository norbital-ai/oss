# syntax=docker/dockerfile:1.12
FROM node:26-alpine

ARG PLATFORM_FINGERPRINT
ARG TEMPLATE_DEPENDENCY_ID
ARG SOURCE_REVISION=unknown

LABEL org.opencontainers.image.title="Norbital tenant builder" \
	org.opencontainers.image.description="Versioned Pod toolchain for hermetic tenant workspace builds" \
	org.opencontainers.image.revision="${SOURCE_REVISION}" \
	dev.norbital.package-key="${PLATFORM_FINGERPRINT}" \
	dev.norbital.template-dependency-key="${TEMPLATE_DEPENDENCY_ID}"

ENV NODE_ENV=production \
	NODE_COMPILE_CACHE=/opt/norbital/tenant-toolchain/.node-compile-cache \
	NODE_COMPILE_CACHE_PORTABLE=1 \
	NPM_CONFIG_UPDATE_NOTIFIER=false \
	NPM_CONFIG_FUND=false \
	NPM_CONFIG_AUDIT=false

RUN test -n "${PLATFORM_FINGERPRINT}" \
	&& test -n "${TEMPLATE_DEPENDENCY_ID}" \
	&& mkdir -p /opt/norbital/tenant-toolchain /opt/norbital/platform-client /workspace \
	&& chown -R node:node /opt/norbital /workspace

COPY --chown=node:node dist/package-archives/ /opt/norbital/package-archives/
COPY --chown=node:node release/template-toolchain.package.json /opt/norbital/tenant-toolchain/package.json

USER node
WORKDIR /opt/norbital/tenant-toolchain

RUN node -e "const manifest=require('./package.json'); if(manifest.norbitalTemplateToolchain?.dependencyKey !== '${TEMPLATE_DEPENDENCY_ID}') process.exit(1)" \
	&& npm install --prefix /opt/norbital/tenant-toolchain --omit=dev --ignore-scripts \
		/opt/norbital/package-archives/config.tgz \
		/opt/norbital/package-archives/platform-utils.tgz \
		/opt/norbital/package-archives/pod.tgz \
		/opt/norbital/package-archives/std.tgz \
		/opt/norbital/package-archives/ui.tgz \
	&& npm ls --prefix /opt/norbital/tenant-toolchain --omit=dev --depth=0 \
	&& printf '%s\n' "${PLATFORM_FINGERPRINT}" > /opt/norbital/tenant-toolchain/.package-key \
	&& printf '%s\n' "${TEMPLATE_DEPENDENCY_ID}" > /opt/norbital/tenant-toolchain/.template-dependency-key \
	&& node /opt/norbital/tenant-toolchain/node_modules/@norbital-ai/pod/build/bin/invocation/index.js \
		platform build /opt/norbital/platform-client "${PLATFORM_FINGERPRINT}" \
	&& test -f /opt/norbital/platform-client/platform-manifest.json \
	# Pod resolves drizzle-kit's root only to locate bin.cjs. The upstream package
	# duplicates every dialect API, payload, and CLI as CJS and ESM; none are loaded
	# by tenant builds or migration generation, so keep the executable and entrypoints.
	&& drizzle_root=/opt/norbital/tenant-toolchain/node_modules/drizzle-kit \
	&& test -f "${drizzle_root}/bin.cjs" \
	&& test -f "${drizzle_root}/index.mjs" \
	&& rm -f \
		"${drizzle_root}"/api-*.js \
		"${drizzle_root}"/api-*.mjs \
		"${drizzle_root}"/payload-*.js \
		"${drizzle_root}"/payload-*.mjs \
		"${drizzle_root}"/cli.js \
		"${drizzle_root}"/cli.mjs \
	&& rm -rf /opt/norbital/package-archives \
	&& npm cache clean --force

ENV NORBITAL_POD_PLATFORM_DIR=/opt/norbital/platform-client

WORKDIR /workspace
ENTRYPOINT []
CMD ["sleep", "infinity"]
