/// <reference types="node" />
// Svelte compiles dominate a workspace build, and most of them are the shell's and ui's components: the same files,
// byte for byte, in every build of every workspace on this Bolt. Each compile result is kept on disk under its inputs,
// so a rebuild compiles only what changed. A hit returns the very object the compiler returned (its code, map and the
// component CSS the virtual style module reads from `meta`), so the output is unchanged.
import { svelte, type Options } from '@sveltejs/vite-plugin-svelte';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

const COMPILE = 'vite-plugin-svelte:compile';
/** Versioned store paths: a different compiler or plugin is a different key. */
const TOOLCHAIN = [
	import.meta.resolve('svelte/compiler'),
	import.meta.resolve('@sveltejs/vite-plugin-svelte')
];

/** `svelte(options)` with its compile step cached in `dir`. */
// ponytail: entries are never pruned (~14 KB each; an edited component adds one), so a long-lived checkout grows; prune
// by age when that matters. A sandbox build only hits when its `.norbital/cache` outlives the build.
export function cachedSvelte(options: Partial<Options>, dir: string): Plugin[] {
	mkdirSync(dir, { recursive: true });
	const plugins = svelte(options);
	for (const plugin of plugins) {
		const transform = plugin.transform;
		if (plugin.name !== COMPILE || transform === undefined || typeof transform === 'function')
			continue;
		const compile = transform.handler;
		// in place: the plugin sets its own `transform.filter` on this object when the config resolves
		// repository-health:allow EFF3 -- Vite owns this transform hook's Promise ABI.
		transform.handler = async function (code, id, meta) {
			const key = createHash('sha256')
				.update(
					JSON.stringify([
						TOOLCHAIN,
						options,
						this.environment.name,
						this.environment.config.consumer,
						id,
						code,
						this.getCombinedSourcemap().mappings
					])
				)
				.digest('hex');
			const file = join(dir, `${key}.json`);
			try {
				return JSON.parse(readFileSync(file, 'utf8'));
			} catch {
				const result = await compile.call(this, code, id, meta);
				if (result !== undefined && result !== null && typeof result === 'object') {
					// written whole, then renamed: a concurrent build never reads half an entry
					const temporary = `${file}.${process.pid}`;
					writeFileSync(temporary, JSON.stringify(result));
					renameSync(temporary, file);
				}
				return result;
			}
		};
	}
	return plugins;
}
