import { opendir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export function isUtf8Text(buf: Uint8Array): boolean {
	try {
		new TextDecoder('utf8', { fatal: true }).decode(buf);
		return true;
	} catch {
		return false;
	}
}

export type WorkspaceSourceWalkOptions = {
	/** Return true if a top-level entry name should be included in the walk. */
	isTopLevelPath: (name: string) => boolean;
	/** Return true if a directory name (at any depth) should be skipped. */
	isForbiddenDir: (name: string) => boolean;
};

export async function walkWorkspaceSourceRelativePaths(
	workspacePath: string,
	options: WorkspaceSourceWalkOptions
): Promise<string[]> {
	const root = path.resolve(workspacePath);
	const rootStat = await stat(root).catch(() => null);
	if (!rootStat?.isDirectory()) {
		return [];
	}

	const relPaths: string[] = [];

	async function collect(dir: string, prefix: string): Promise<void> {
		const dh = await opendir(dir);
		for await (const entry of dh) {
			if (!prefix && !options.isTopLevelPath(entry.name)) {
				continue;
			}

			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			const childAbs = path.join(dir, entry.name);

			if (entry.isDirectory()) {
				if (options.isForbiddenDir(entry.name)) {
					continue;
				}
				await collect(childAbs, rel);
				continue;
			}

			if (!entry.isFile()) continue;

			const buf = await readFile(childAbs);
			const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
			if (!isUtf8Text(view)) continue;

			relPaths.push(rel);
		}
	}

	await collect(root, '');
	return relPaths.sort((a, b) => a.localeCompare(b));
}

export async function walkWorkspaceSourceFiles(
	workspacePath: string,
	options: WorkspaceSourceWalkOptions
): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	const relPaths = await walkWorkspaceSourceRelativePaths(workspacePath, options);
	await Promise.all(
		relPaths.map(async (relPath) => {
			const body = await readFile(path.join(workspacePath, relPath));
			files[relPath] = Buffer.from(body).toString('utf8');
		})
	);
	return files;
}
