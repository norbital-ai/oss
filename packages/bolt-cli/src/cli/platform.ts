/// <reference types="node" />
import { Argument, Command } from 'effect/cli';
import { resolve } from 'node:path';
import { prepareLayer } from '../compiler/artifact/client.ts';

/** `bolt platform <dir>`: this install's platform layer under `dir`, which `bolt build --platform=<dir>` reads. */
export const platformCommand = Command.make(
	'platform',
	{ dir: Argument.String('dir') },
	({ dir }) => prepareLayer(resolve(dir))
);
