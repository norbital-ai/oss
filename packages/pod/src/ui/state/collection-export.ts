import {
	ExportManifestSchema,
	type TExportManifest,
	type TFileAttachment
} from '$lib/authoring/automations/pipelines.js';
import {
	getWorkspaceRemoteTransport,
	type WorkspaceRemoteTransport
} from '$lib/authoring/workspace/remote-transport.js';
import { z } from 'zod';

export type CollectionExportInput = Parameters<WorkspaceRemoteTransport['exportPipeline']>[0];

export interface SerializedExportAttachment {
	readonly name: string;
	readonly mimeType: string;
	readonly body: string | Uint8Array<ArrayBuffer>;
}

export interface CollectionExportDownloadOptions {
	readonly includeAction?: (action: TExportManifest[number]) => boolean;
}

const csvRecordSchema = z.record(z.string(), z.unknown());

function safeDownloadName(name: string): string {
	const basename = name.replaceAll('\\', '/').split('/').at(-1)?.trim() ?? '';
	const safe = basename.replace(/[\u0000-\u001f\u007f]/g, '');
	return safe === '' || safe === '.' || safe === '..' ? 'download' : safe;
}

function stringifyJson(value: unknown): string {
	try {
		const json = JSON.stringify(value, null, 2);
		if (json === undefined) throw new Error('value is not JSON-serializable');
		return json;
	} catch (cause) {
		throw new Error('Export attachment contains invalid JSON content', { cause });
	}
}

function csvCell(value: unknown): string {
	const text =
		value == null
			? ''
			: typeof value === 'string'
				? value
				: typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
					? String(value)
					: stringifyJson(value).replaceAll('\n', ' ');
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvRows(rows: readonly (readonly unknown[])[]): string {
	return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

function serializeCsv(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return csvRows([[content]]);
	if (content.every((row) => Array.isArray(row))) return csvRows(content);

	const records: Record<string, unknown>[] = [];
	for (const row of content) {
		const result = csvRecordSchema.safeParse(row);
		if (!result.success) return csvRows(content.map((value) => [value]));
		records.push(result.data);
	}
	const headers = [...new Set(records.flatMap((record) => Object.keys(record)))];
	return csvRows([headers, ...records.map((record) => headers.map((header) => record[header]))]);
}

function pdfBody(content: string): string | Uint8Array<ArrayBuffer> {
	const prefix = 'data:application/pdf;base64,';
	if (!content.startsWith(prefix)) return content;
	const decoded = atob(content.slice(prefix.length));
	return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export function serializeExportAttachment(attachment: TFileAttachment): SerializedExportAttachment {
	const name = safeDownloadName(attachment.name);
	switch (attachment.contentType) {
		case 'HTML':
			return { name, mimeType: 'text/html;charset=utf-8', body: attachment.content };
		case 'PDF':
			return { name, mimeType: 'application/pdf', body: pdfBody(attachment.content) };
		case 'CSV':
			return { name, mimeType: 'text/csv;charset=utf-8', body: serializeCsv(attachment.content) };
		case 'XLSX':
			return {
				name,
				mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
				body: new Uint8Array(attachment.content)
			};
		case 'JSON':
			return {
				name,
				mimeType: 'application/json;charset=utf-8',
				body: stringifyJson(attachment.content)
			};
		case 'TEXT':
			return { name, mimeType: 'text/plain;charset=utf-8', body: attachment.content };
		case 'BINARY':
			return {
				name,
				mimeType: 'application/octet-stream',
				body: new Uint8Array(attachment.content)
			};
		default:
			return attachment satisfies never;
	}
}

function downloadAttachment(attachment: TFileAttachment): void {
	const serialized = serializeExportAttachment(attachment);
	const url = URL.createObjectURL(new Blob([serialized.body], { type: serialized.mimeType }));
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = serialized.name;
	anchor.hidden = true;
	document.body.appendChild(anchor);
	try {
		anchor.click();
	} finally {
		anchor.remove();
		URL.revokeObjectURL(url);
	}
}

export async function downloadCollectionExport(
	input: CollectionExportInput,
	options: CollectionExportDownloadOptions = {}
): Promise<TExportManifest> {
	if (typeof document === 'undefined') {
		throw new Error('Collection exports can only be downloaded in a browser');
	}
	const output = await getWorkspaceRemoteTransport().exportPipeline(input);
	const manifest = ExportManifestSchema.parse(output).filter(
		(action) => options.includeAction?.(action) ?? true
	);
	for (const action of manifest) {
		for (const attachment of action.attachments) downloadAttachment(attachment);
	}
	return manifest;
}
