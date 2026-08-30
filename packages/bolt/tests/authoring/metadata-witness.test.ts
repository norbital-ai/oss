import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ModelMetadata } from '../../src/authoring/models-schema.js';
import { file, text, vector } from '../../src/authoring/models-schema.js';

/**
 * Every option the authoring surface accepts, held against the function that reads it.
 *
 * `text({ search: true })` was accepted and discarded for months: the search box looked broken and
 * nothing anywhere failed, because an accepted-and-dropped option is invisible — it has no call
 * site to grep for and no test to break. Seven more were dropped the same way before anyone counted.
 *
 * So the count is written down. Each literal below is typed `Required<…>` of a real authoring
 * interface, which makes it a compile error to add an option without listing it here, and a compile
 * error to delete one without removing it. Each listed key must then be either in `readBy`, naming
 * a function that demonstrably reads it, or in `acceptedButUnread` with the reason it survives
 * unread. There is no third answer, and "I forgot" is not one of them.
 *
 * This is the `SystemRow` mapped type in `src/compiler/schema-plan.ts` applied to options rather
 * than columns: the same trick of making a type the thing that fails.
 */

const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));

/** Every authored source file, read once, so a witness can prove its reader exists in the package. */
const sourceFiles = async (
	directory: string
): Promise<ReadonlyArray<{ readonly path: string; readonly text: string }>> => {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return sourceFiles(path);
			if (!/\.(ts|svelte)$/.test(entry.name)) return [];
			return [{ path, text: await readFile(path, 'utf8') }];
		})
	);
	return nested.flat();
};

/**
 * `Required<ModelMetadata>`: the literal cannot compile while it disagrees with the interface.
 *
 * The values are placeholders and are never read — only the key set is the assertion.
 */
const MODEL_METADATA: Required<ModelMetadata> = {
	description: '',
	recordLabel: '',
	icon: '',
	history: true,
	sync: true,
	indexes: [],
	exclusions: [],
	embedding: { fields: [] }
};

/** `text()`, `phone()` and `enums()` share one bag, so one witness covers all three. */
const TEXT_OPTIONS: Required<NonNullable<Parameters<typeof text>[0]>> = { search: true };
const FILE_OPTIONS: Required<NonNullable<Parameters<typeof file>[0]>> = {
	mimeTypes: [],
	multiple: true
};
const VECTOR_OPTIONS: Required<Parameters<typeof vector>[0]> = { dimensions: 1 };

type Witness = Readonly<{
	readonly authoring: string;
	readonly options: Readonly<Record<string, unknown>>;
	/** Option name to the function that reads it. Both must appear in one source file. */
	readonly readBy: Readonly<Record<string, string>>;
	/** Option name to the reason it is accepted and knowingly dropped. Empty is the goal state. */
	readonly acceptedButUnread: Readonly<Record<string, string>>;
}>;

const WITNESSES: ReadonlyArray<Witness> = [
	{
		authoring: 'ModelMetadata',
		options: MODEL_METADATA,
		readBy: {
			// Gates the `bolt_collection_history` writes in `Collections`. The collection descriptor
			// hardcodes `history: true`, so this lift is what makes `history: false` mean anything —
			// without it the option was accepted and the revision trail written anyway.
			history: 'renderArtifact',
			sync: 'compileModel',
			indexes: 'authoredIndex',
			exclusions: 'renderArtifact',
			recordLabel: 'extractCollectionCatalog',
			// Two readers, one declaration: `compileModelTable` renders the embedding/staleness columns
			// and `recordEmbeddingIndexes` its HNSW index, so a declared embedding reaches the lineage
			// as both. Named here by the one that owns the column.
			embedding: 'recordEmbeddingColumns',
			// Lifted off `model.metadata` onto the collection descriptor beside `exclusions`, then
			// projected by `workspace.manifest` so a host surface can read them.
			description: 'renderArtifact',
			icon: 'renderArtifact'
		},
		acceptedButUnread: {}
	},
	{
		authoring: 'text/phone/enums options',
		options: TEXT_OPTIONS,
		readBy: { search: 'describeModelColumns' },
		acceptedButUnread: {}
	},
	{
		authoring: 'file options',
		options: FILE_OPTIONS,
		readBy: { mimeTypes: 'describeModelColumns', multiple: 'describeModelColumns' },
		acceptedButUnread: {}
	},
	{
		authoring: 'vector options',
		options: VECTOR_OPTIONS,
		readBy: { dimensions: 'pgVector' },
		acceptedButUnread: {}
	}
];

describe('authoring option witnesses', () => {
	for (const witness of WITNESSES) {
		it(`accounts for every ${witness.authoring} option exactly once`, () => {
			const declared = Object.keys(witness.options).toSorted();
			const accounted = [
				...Object.keys(witness.readBy),
				...Object.keys(witness.acceptedButUnread)
			].toSorted();
			// One list against the other, both ways: an option missing from the maps is an option
			// nobody decided about, and an option in the maps that no longer exists is a stale claim.
			expect(accounted).toEqual(declared);
		});
	}

	it('proves each named reader exists beside the option it claims to read', async () => {
		const files = await sourceFiles(sourceRoot);
		const unproven = WITNESSES.flatMap((witness) =>
			Object.entries(witness.readBy)
				.filter(
					([option, reader]) =>
						!files.some(({ text: source }) => source.includes(reader) && source.includes(option))
				)
				.map(([option, reader]) => `${witness.authoring}.${option} claims ${reader}`)
		);
		// Naming a reader that has been renamed or deleted is exactly the state this file exists to
		// catch, so the claim is checked against the source rather than trusted.
		expect(unproven).toEqual([]);
	});

	it('names the accepted-but-unread options, so the set is a list and not a rumour', () => {
		const unread = WITNESSES.flatMap((witness) =>
			Object.keys(witness.acceptedButUnread).map((option) => `${witness.authoring}.${option}`)
		);
		// Update this literal when one is wired or deleted. `[]` is the goal state, and — with
		// With presentation metadata lifted onto the collection descriptor and projected by
		// `workspace.manifest`, every authoring option this package accepts is
		// now read by something.
		expect(unread).toEqual([]);
		for (const reason of WITNESSES.flatMap((witness) => Object.values(witness.acceptedButUnread))) {
			expect(reason.length).toBeGreaterThan(0);
		}
	});
});
