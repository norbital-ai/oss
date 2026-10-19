/// <reference types="node" />
import { Effect, FileSystem } from 'effect';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Discovered } from '../discover.ts';

const EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '../..');
const key = JSON.stringify;

/** One concrete, codec-typed component shared by the route's server render and browser hydration. */
export const publicWrapper = Effect.fn('bolt.publicWrapper')(function* (
	root: string,
	file: Discovered
) {
	const fs = yield* FileSystem.FileSystem;
	const route = `${file.role === 'page' ? 'app' : 'kiosk'}/${file.name}`;
	const path = join(root, '.norbital', 'cache', 'public', `${route}.svelte`);
	const codec = join(root, file.path.replace(/\+([^/]+)\.page\.svelte$/, '$1.page.data.ts'));
	const source = `<script lang="ts">
import type { Schema } from 'effect';
import type { PublicBoot } from ${key(join(SOURCE, 'protocol', `public-page${EXT}`))};
import PublicPage from ${key(join(SOURCE, 'shell', 'public', 'PublicPage.svelte'))};
import Page from ${key(join(root, file.path))};
import dataCodec from ${key(codec)};
let { data, boot }: { data: Schema.Schema.Type<typeof dataCodec>; boot: PublicBoot } = $props();
</script>
<PublicPage {boot}><Page {data} /></PublicPage>
`;
	yield* fs.makeDirectory(dirname(path), { recursive: true });
	yield* fs.writeFileString(path, source);
	return path;
});
