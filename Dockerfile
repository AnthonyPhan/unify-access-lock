FROM ghcr.io/home-assistant/base:latest

ARG BUILD_VERSION
ARG BUILD_ARCH

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}"

RUN apk add --no-cache nodejs npm

WORKDIR /opt/doorstate

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY public ./public
COPY src ./src
COPY run.sh /run.sh

RUN npm run build \
  && npm prune --omit=dev \
  && chmod a+x /run.sh

CMD [ "/run.sh" ]
