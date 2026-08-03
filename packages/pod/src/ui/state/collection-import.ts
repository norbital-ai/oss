import {
	getWorkspaceRemoteTransport,
	type WorkspaceRemoteTransport
} from '$lib/authoring/workspace/remote-transport.js';
import { z } from 'zod';

export type CollectionImportInput = Parameters<WorkspaceRemoteTransport['importPipeline']>[0];
export type ImportedCollectionRecord = Readonly<Record<string, unknown>>;

const importedCollectionRecordsSchema = z.array(z.record(z.string(), z.unknown()));

export async function importCollectionRecords(
	input: CollectionImportInput
): Promise<readonly ImportedCollectionRecord[]> {
	const output = await getWorkspaceRemoteTransport().importPipeline(input);
	return importedCollectionRecordsSchema.parse(output);
}
