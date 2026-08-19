import { Schema } from 'effect';
import { workspaceSession } from '../../session.js';

export type CollectionExportInput = Readonly<
	(
		| { readonly collection: string; readonly collection_name?: never }
		| { readonly collection?: never; readonly collection_name: string }
	) & {
		readonly records?: ReadonlyArray<string>;
		readonly record_ids?: ReadonlyArray<string>;
		readonly pipeline?: string;
		readonly scope?: unknown;
	}
>;
export type ExportAttachment = Readonly<{
	readonly name: string;
	readonly contentType: string;
	readonly content: unknown;
}>;
export type ExportAction = Readonly<{
	readonly label: string;
	readonly attachments: ReadonlyArray<ExportAttachment>;
	readonly metadata?: Readonly<Record<string, unknown>>;
}>;
export type ExportManifest = Readonly<ReadonlyArray<ExportAction>>;
export type CollectionExportOptions = Readonly<{
	readonly includeAction?: (action: ExportAction) => boolean;
}>;

/**
 * Both command responses are decoded, not cast.
 *
 * The server is trusted to be the right server, not to have sent the right shape — an export
 * pipeline is authored per workspace, so a manifest that lost its `attachments` is a workspace bug
 * that has to surface here rather than as `undefined.length` inside a download button. Decoding also
 * strips keys the manifest does not declare, which is what the zod schemas these replaced did.
 */
const decodeExportManifest = Schema.decodeUnknownSync(
	Schema.Array(
		Schema.Struct({
			label: Schema.String,
			attachments: Schema.Array(
				Schema.Struct({ name: Schema.String, contentType: Schema.String, content: Schema.Unknown })
			),
			metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
		})
	)
);
/**
 * The import command answers with a count, not with the records it wrote.
 *
 * It cannot answer with rows. One posted file is one `records` entry, and the collection's import
 * pipeline is what turns that entry into however many writes it becomes — a month grid of thirty day
 * columns is a single statement that lands as hundreds of roster rows. `imported` is the pipeline's
 * own row count, and so the only number a caller can honestly put in front of a person. This used to
 * decode an array of records, which no version of the command has ever sent.
 */
const decodeImportResult = Schema.decodeUnknownSync(Schema.Struct({ imported: Schema.Number }));

/**
 * Export and import over the session's transport, not over a third `fetch`.
 *
 * These two posted to a literal `/api/bolt/command/...` with a credential read off the document,
 * which was a third implementation of the one thing `BoltTransport` already is — one that could
 * disagree with the other two about where a command goes and who is issuing it.
 */
const CollectionTransfer = {
	download: async (
		input: CollectionExportInput,
		options: CollectionExportOptions = {}
	): Promise<ExportManifest> => {
		const manifest = decodeExportManifest(
			await workspaceSession().transport.command('collections.export', input as unknown as Schema.Json)
		);
		return options.includeAction === undefined ? manifest : manifest.filter(options.includeAction);
	},
	importRecords: async (input: CollectionImportInput): Promise<number> =>
		decodeImportResult(
			await workspaceSession().transport.command('collections.import', input as Schema.Json)
		).imported
};
export const downloadCollectionExport = CollectionTransfer.download;

/**
 * One record as `collections.import` declares it — the same mutation shape `collections.create`
 * posts: where it goes, what identifies it, and what it carries.
 *
 * `values` is where an import differs from a create. On a collection with an import pipeline these
 * are not the record's columns; they are the document the pipeline declares as its `input`, and the
 * pipeline is what turns that document into rows. Which is why one file is one record rather than
 * one record per spreadsheet row: a roster file's `roster_id` and `month` are assertions about the
 * whole file, and there is no row for them to ride on.
 *
 * `id` is required by the command even though a pipeline-backed import never stores it — the ids of
 * what actually gets written come back off the rows the pipeline returns. Mint it the way
 * `collections.create` mints one, with `crypto.randomUUID()`.
 */
export type CollectionImportRecord = Readonly<{
	readonly collection: string;
	readonly id: string;
	readonly values: Readonly<Record<string, unknown>>;
}>;
/**
 * The command's declared body, and nothing besides.
 *
 * This used to be `{ collection_name, import_data }`, which the server has never declared: the
 * request was refused in the decoder, before any authored import pipeline was reached, and the
 * refusal read as a generic import failure. `records` is the only field a caller supplies.
 *
 * The struct's fourth field, `subject`, is deliberately absent here. It is injected at the boundary
 * from the credential this request authenticated with, for the same reason it is injected on every
 * other tenant-data command: a body that could name its own subject is a body that could write into
 * someone else's tenant.
 */
export type CollectionImportInput = Readonly<{
	readonly records: ReadonlyArray<CollectionImportRecord>;
}>;
/** Owns import collection records behavior at the state boundary so validation and typed semantics stay consistent for every caller. */
export const importCollectionRecords = CollectionTransfer.importRecords;
