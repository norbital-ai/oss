import { Schema } from 'effect';

export type CollectionExportInput = Readonly<(
	| { readonly collection: string; readonly collection_name?: never }
	| { readonly collection?: never; readonly collection_name: string }
) & {
	readonly records?: ReadonlyArray<string>;
	readonly record_ids?: ReadonlyArray<string>;
	readonly pipeline?: string;
	readonly scope?: unknown;
}>;
export type ExportAttachment = Readonly<{ readonly name: string; readonly contentType: string; readonly content: unknown }>;
export type ExportAction = Readonly<{ readonly label: string; readonly attachments: ReadonlyArray<ExportAttachment>; readonly metadata?: Readonly<Record<string, unknown>> }>;
export type ExportManifest = Readonly<ReadonlyArray<ExportAction>>;
export type CollectionExportOptions = Readonly<{ readonly includeAction?: (action: ExportAction) => boolean }>;

/**
 * Both command responses are decoded, not cast.
 *
 * The server is trusted to be the right server, not to have sent the right shape — an export
 * pipeline is authored per workspace, so a manifest that lost its `attachments` is a workspace bug
 * that has to surface here rather than as `undefined.length` inside a download button. Decoding also
 * strips keys the manifest does not declare, which is what the zod schemas these replaced did.
 */
const decodeExportManifest = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({
	label: Schema.String,
	attachments: Schema.Array(Schema.Struct({ name: Schema.String, contentType: Schema.String, content: Schema.Unknown })),
	metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
})));
const decodeRecords = Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)));

const commandHeaders = (): Readonly<Record<string, string>> => {
	const authorization =
		typeof document === 'undefined' ? undefined : document.documentElement.dataset['boltAuthorization'];
	return {
		'content-type': 'application/json',
		...(authorization === undefined || authorization.length === 0 ? {} : { authorization })
	};
};

/** Owns download collection export behavior at the state boundary so validation and typed semantics stay consistent for every caller. */
const CollectionTransfer = {
	download: async (input: CollectionExportInput, options: CollectionExportOptions = {}): Promise<ExportManifest> => {
		const response = await fetch('/api/bolt/command/collections.export', { method: 'POST', credentials: 'same-origin', headers: commandHeaders(), body: JSON.stringify(input) });
		if (!response.ok) throw new Error(`Collection export failed (${response.status})`);
		const manifest = decodeExportManifest(await response.json());
		return options.includeAction === undefined ? manifest : manifest.filter(options.includeAction);
	},
	importRecords: async (input: CollectionImportInput): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>> => {
		const response = await fetch('/api/bolt/command/collections.import', { method: 'POST', credentials: 'same-origin', headers: commandHeaders(), body: JSON.stringify(input) });
		if (!response.ok) throw new Error(`Collection import failed (${response.status})`);
		return decodeRecords(await response.json());
	}
};
export const downloadCollectionExport = CollectionTransfer.download;

export type CollectionImportInput = Readonly<(
	| { readonly collection: string; readonly collection_name?: never }
	| { readonly collection?: never; readonly collection_name: string }
) & { readonly data?: unknown; readonly import_data?: unknown; readonly pipeline?: string }>;
/** Owns import collection records behavior at the state boundary so validation and typed semantics stay consistent for every caller. */
export const importCollectionRecords = CollectionTransfer.importRecords;
