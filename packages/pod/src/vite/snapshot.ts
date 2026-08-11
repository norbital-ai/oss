import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUNTIME_SNAPSHOT_FILENAME } from '@norbital-ai/platform-utils/tenant_workspace/build-output';
import { STDIO_FRAME_GUARD_SOURCE } from '../serve/stdio.js';

/**
 * V8 startup-snapshot generation for the tenant server bundle.
 *
 * A cold runtime guest currently pays two costs before it can serve: node's own interpreter boot,
 * and the parse/compile of the ~3.3 MB server bundle. The second one is what this eliminates. The
 * bundle is compiled once here, in the build sandbox, and the resulting heap is serialised into
 * `runtime.snap`; the guest then boots with `node --snapshot-blob=runtime.snap`, which restores the
 * compiled bundle instead of re-parsing it. Measured on a real bundle: the module import drops from
 * ~1.5–2 s to ~0.1 s, and the win is larger in a cold guest where the page cache is empty.
 *
 * Why this shape:
 *
 * - **Single bundled entry.** Node's snapshot builder can only load one userland entrypoint, so the
 *   whole server bundle is first rolled into one CJS file, and the snapshot builder is bundled
 *   together with it.
 * - **`node:http` stays lazy.** `node:http`'s native HTTPParser handle is not serialisable — the
 *   builder would crash with `CheckGlobalAndEternalHandles failed`. The serve source loads
 *   `node:http` via a dynamic import inside `createPodHttpServer` (never at module scope), and this
 *   bundling keeps that dynamic import external, so the snapshot never touches it.
 * - **Deserialise straight into serving.** The builder registers a deserialize-main that installs
 *   the stdout frame guard (exactly what `serve.mjs` does) and then starts the HTTP server. `process.env`
 *   is refreshed at deserialisation time, so `POD_RUNTIME_PORT` / `POD_HOST_TOKEN` are read fresh.
 *
 * Fail-soft on purpose: a checkpoint without `runtime.snap` is still valid — the guest falls back
 * to `serve.mjs`. A snapshot build failure must never break a tenant build.
 */

/** Externalised node built-ins: everything except `node:http`, which must stay lazy AND external. */
function isExternalNodeBuiltin(id: string): boolean {
	return id.startsWith('node:') && id !== 'node:http';
}

function snapshotBuilderSource(bundleRelativePath: string): string {
	return `${STDIO_FRAME_GUARD_SOURCE}const { startupSnapshot } = require('node:v8');
const { startPodHttpServer } = require(${JSON.stringify(bundleRelativePath)});
startupSnapshot.setDeserializeMainFunction(() => startPodHttpServer());
`;
}

/**
 * Node restores a startup snapshot's deserialize callback through `vm.Script`. A dynamic import
 * captured in that callback has no `importModuleDynamically` hook after restore and crashes with
 * `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`. The ordinary ESM runtime still needs the lazy import,
 * but this generated artifact is CommonJS, so its one lazy `node:http` load can use `require`.
 */
export function makeSnapshotBundleVmCompatible(code: string): string {
	const lazyNodeHttpImport = /import\((['"])node:http\1\)/g;
	const matches = [...code.matchAll(lazyNodeHttpImport)];
	if (matches.length !== 1) {
		throw new Error(
			`Expected exactly one lazy node:http import in the snapshot bundle, found ${matches.length}`
		);
	}
	return code.replace(lazyNodeHttpImport, "Promise.resolve(require('node:http'))");
}

/**
 * Produce `runtime.snap` at the artifact root, or leave it absent when anything fails.
 *
 * Runs rolldown (already a dependency of the tenant build via vite) to roll `output/server/index.js`
 * into a single CJS file with `node:http` external, then invokes `node --build-snapshot-config` in a
 * child process bounded to a heap that fits the build sandbox's memory ceiling. Any failure is
 * swallowed and logged through `log` — the checkpoint remains servable via `serve.mjs`.
 */
export async function generateRuntimeSnapshot(input: {
	artifactRoot: string;
	log: (message: string) => void;
}): Promise<boolean> {
	const { artifactRoot, log } = input;
	const serverIndex = path.join(artifactRoot, 'output', 'server', 'index.js');
	const scratch = path.join(artifactRoot, '.snapshot-build');
	try {
		const { rolldown } = await import('rolldown');
		await mkdir(scratch, { recursive: true });
		// 1. Roll the ESM server bundle into one CJS file, node built-ins external (node:http lazy).
		//    `codeSplitting: false` is what makes it ONE file — the original build is already split,
		//    and its chunk imports would otherwise survive the re-bundle as relative requires.
		const bundle = await rolldown({
			input: pathToFileURL(serverIndex).href,
			platform: 'node',
			external: isExternalNodeBuiltin,
			resolve: { extensions: ['.js', '.mjs'] }
		});
		const { output } = await bundle.generate({ format: 'cjs', codeSplitting: false });
		const bundleFile = path.join(scratch, 'server-bundle.cjs');
		await writeFile(bundleFile, makeSnapshotBundleVmCompatible(output[0].code));

		// 2. The snapshot builder: guard stdout, then start the server on deserialise.
		const builderFile = path.join(scratch, 'snapshot-builder.cjs');
		await writeFile(builderFile, snapshotBuilderSource('./server-bundle.cjs'));
		const { rolldown: bundleBuilder } = await import('rolldown');
		const builderBundle = await bundleBuilder({
			input: pathToFileURL(builderFile).href,
			platform: 'node',
			external: isExternalNodeBuiltin,
			resolve: { extensions: ['.js', '.mjs'] }
		});
		const { output: builderOutput } = await builderBundle.generate({
			format: 'cjs',
			codeSplitting: false
		});
		const builderBundled = path.join(scratch, 'builder-bundled.cjs');
		await writeFile(builderBundled, builderOutput[0].code);

		// 3. Build the snapshot. The config's `output` field is ignored by this node; the blob lands
		//    in the working directory as `snapshot.blob`, so run with the scratch as cwd and rename.
		const configFile = path.join(scratch, 'snapcfg.json');
		await writeFile(configFile, JSON.stringify({ builder: builderBundled }));
		execFileSync(
			process.execPath,
			['--build-snapshot-config=' + configFile, '--max-old-space-size=420'],
			{ cwd: scratch, stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 }
		);
		const blob = path.join(scratch, 'snapshot.blob');
		await rename(blob, path.join(artifactRoot, RUNTIME_SNAPSHOT_FILENAME));
		const size = (await readFile(path.join(artifactRoot, RUNTIME_SNAPSHOT_FILENAME))).length;
		log(`[pod] built ${RUNTIME_SNAPSHOT_FILENAME} (${(size / 1_048_576).toFixed(1)} MiB)`);
		return true;
	} catch (error) {
		log(
			`[pod] ${RUNTIME_SNAPSHOT_FILENAME} generation skipped (guest will boot via serve.mjs): ${
				error instanceof Error ? error.message : String(error)
			}`
		);
		return false;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
