/// <reference types="node" />
import { Effect, FileSystem } from 'effect';
import { dirname, join } from 'node:path';
import type { Discovered } from '../discover.ts';
import { BOLT, EXT } from '../bolt.ts';

const key = JSON.stringify;

/** One concrete component shared by the route's server render and browser hydration. */
export const publicWrapper = Effect.fn('bolt.publicWrapper')(function* (
	root: string,
	file: Discovered,
	route: string
) {
	const fs = yield* FileSystem.FileSystem;
	const path = join(root, '.norbital', 'cache', 'public', `${route}.svelte`);

	const source = `<script lang="ts">
import type { PublicBoot } from ${key(join(BOLT, 'protocol', `public-page${EXT}`))};
import type { PublicClient } from ${key(join(BOLT, 'shell', 'public', `client${EXT}`))};
import PublicPage from ${key(join(BOLT, 'shell', 'public', 'PublicPage.svelte'))};
import Page from ${key(join(root, file.path))};
let { boot, ctx }: { boot: PublicBoot; ctx: PublicClient } = $props();
</script>
<PublicPage {boot} {ctx}><Page {ctx} /></PublicPage>
`;
	yield* fs.makeDirectory(dirname(path), { recursive: true });
	yield* fs.writeFileString(path, source);
	return path;
});
