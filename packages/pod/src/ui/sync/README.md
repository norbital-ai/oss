# Pod Sync Engine — client implementation

This directory contains the client-side sync engine implementation: PodSyncClient, the local
PGlite executor, live query registry, optimistic write overlay, and SharedWorker bridge.

The canonical sync engine documentation — architecture, invariants, wire protocol, and how to
author queries and mutations — lives at [`packages/pod/docs/SYNC_ENGINE.md`](../../../../docs/SYNC_ENGINE.md).

Server-side sync code is in `packages/pod/src/server/collection/sync/`.
