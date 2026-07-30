FROM postgres:18-alpine AS build

RUN apk add --no-cache build-base git
RUN git clone --depth 1 --branch v1.2.2 https://github.com/arkhipov/temporal_tables.git /src
WORKDIR /src
RUN make with_llvm=no && make with_llvm=no install

FROM postgres:18-alpine

COPY --from=build /usr/local/lib/postgresql/temporal_tables.so /usr/local/lib/postgresql/temporal_tables.so
COPY --from=build /usr/local/share/postgresql/extension/temporal_tables* /usr/local/share/postgresql/extension/
