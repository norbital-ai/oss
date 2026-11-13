/// <reference types="node" />
import { Argument, Command } from 'effect/cli';
import { resolve } from 'node:path';
import { prepareLayer } from '../compiler/artifact/client.ts';

/**
 * `bolt platform <dir>`: this install's platform layer under `dir`, which `bolt build --platform=<dir>` reads.
 *
 * The layer is the browser code of Bolt's shell, ui, svelte and effect: nothing of a workspace. A host keeps one per
 * package graph and mounts it read-only into every build on that graph; such a build leaves
 * `client/assets/platform/**` out for the host to add, its digests already counted, so the release is byte for byte
 * the one a plain build writes. Exit 0 ok, 2 tool failure.
 */
export const platformCommand = Command.make(
	'platform',
	{ dir: Argument.String('dir').pipe(Argument.withDescription('the directory the platform layer is written to')) },
	({ dir }) => prepareLayer(resolve(dir))
);
