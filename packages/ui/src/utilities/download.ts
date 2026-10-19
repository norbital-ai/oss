import { strToU8, zipSync } from 'fflate';
import { Result } from 'effect';

const basename = (name: string) => {
	const value = name.replaceAll('\\', '/').split('/').at(-1) ?? '';
	return value === '' || value === '.' || value === '..' ? 'document.txt' : value;
};

/** One text file downloads directly; a batch downloads as one ZIP, retaining duplicate names. */
export function downloadTextFiles(
	files: readonly { name: string; content: string }[],
	archiveName = 'export.zip'
): void {
	if (files.length === 0) return;
	const used = new Set<string>();
	const entries =
		files.length > 1
			? files.map((file) => {
					const original = basename(file.name),
						dot = original.lastIndexOf('.');
					const stem = dot > 0 ? original.slice(0, dot) : original,
						extension = dot > 0 ? original.slice(dot) : '';
					let name = original,
						occurrence = 1;
					while (used.has(name)) name = `${stem} (${++occurrence})${extension}`;
					used.add(name);
					return [name, strToU8(file.content)] as const;
				})
			: [];
	const single = files[0];
	const blob =
		single !== undefined && files.length === 1
			? new Blob([single.content], {
					type: single.name.endsWith('.csv') ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8'
				})
			: new Blob([new Uint8Array(zipSync(Object.fromEntries(entries)))], {
					type: 'application/zip'
				});
	const href = URL.createObjectURL(blob);
	const link = Object.assign(document.createElement('a'), {
		href,
		download: files.length === 1 ? basename(single?.name ?? '') : basename(archiveName)
	});
	document.body.append(link);
	const clicked = Result.try(() => link.click());
	link.remove();
	setTimeout(() => URL.revokeObjectURL(href), 1000);
	Result.getOrThrow(clicked);
}
