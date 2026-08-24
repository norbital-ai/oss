#!/usr/bin/env node
/**
 * Node's executable boundary owns the Promise that keeps the command alive.
 *
 * Effect-owned orchestration lives in `cli-main`; this module does the one adaptation only an ESM
 * entry can do: top-level await. A pending Promise by itself does not keep Node alive, so discarding
 * `Effect.runPromise` or starting a daemon fiber lets a command exit between asynchronous handles.
 */
import { completion } from './cli-main.js';

await completion;
