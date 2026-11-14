/// <reference types="node" />
// This process's own Bolt API reference (`build/docs/`): the artifact port serves it at `../docs/<file>`.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// `src/node` and `build/node` are both two levels under the package root, so this resolves from either. A path, not
// `new URL(…, import.meta.url)`, which Vite rewrites to a served asset URL outside Node environments.
export const DOCS_DIR = pathToFileURL(join(import.meta.dirname, '../../build/docs/'));
