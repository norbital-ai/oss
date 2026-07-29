# @norbital-ai/platform-utils

## 0.0.1

- Initial baseline release of the tenant build, checkpoint, storage, and authoring contracts.
- Checkpoint identities use the tenant tree hash plus the build pipeline generation. What a build compiled against lives in the tenant's own committed `pnpm-lock.yaml`.
- Browser-safe authoring gateways keep server-only storage out of client bundles.
