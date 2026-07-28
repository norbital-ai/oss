# syntax=docker/dockerfile:1.12
FROM node:26-alpine

ARG PACKAGE_REGISTRY_URL=https://registry.npmjs.org
ARG CONFIG_VERSION
ARG PLATFORM_UTILS_VERSION
ARG POD_VERSION
ARG STD_VERSION
ARG UI_VERSION
ARG PLATFORM_FINGERPRINT
ARG SOURCE_REVISION=unknown

LABEL org.opencontainers.image.title="Norbital tenant builder" \
	org.opencontainers.image.description="Versioned Pod toolchain for hermetic tenant workspace builds" \
	org.opencontainers.image.revision="${SOURCE_REVISION}" \
	dev.norbital.package-registry="${PACKAGE_REGISTRY_URL}" \
	dev.norbital.package-key="${PLATFORM_FINGERPRINT}"

ENV NODE_ENV=production \
	NPM_CONFIG_UPDATE_NOTIFIER=false \
	NPM_CONFIG_FUND=false \
	NPM_CONFIG_AUDIT=false

RUN test -n "${CONFIG_VERSION}" \
	&& test -n "${PLATFORM_UTILS_VERSION}" \
	&& test -n "${POD_VERSION}" \
	&& test -n "${STD_VERSION}" \
	&& test -n "${UI_VERSION}" \
	&& test -n "${PLATFORM_FINGERPRINT}" \
	&& mkdir -p /opt/norbital/tenant-toolchain /opt/norbital/platform-client /workspace \
	&& chown -R node:node /opt/norbital /workspace

USER node

RUN --mount=type=secret,id=npmrc,target=/home/node/.npmrc,uid=1000,gid=1000,required=false \
	npm install --prefix /opt/norbital/tenant-toolchain --omit=dev --ignore-scripts \
		"@norbital-ai/config@${CONFIG_VERSION}" \
		"@norbital-ai/platform-utils@${PLATFORM_UTILS_VERSION}" \
		"@norbital-ai/pod@${POD_VERSION}" \
		"@norbital-ai/std@${STD_VERSION}" \
		"@norbital-ai/ui@${UI_VERSION}" \
	&& printf '%s\n' "${PLATFORM_FINGERPRINT}" > /opt/norbital/tenant-toolchain/.package-key \
	&& node /opt/norbital/tenant-toolchain/node_modules/@norbital-ai/pod/build/bin/invocation/index.js \
		platform build /opt/norbital/platform-client "${PLATFORM_FINGERPRINT}" \
	&& npm cache clean --force

WORKDIR /workspace
ENTRYPOINT []
CMD ["sleep", "infinity"]
