import { Result } from 'effect';

const basename = (name: string) => {
	const value = name.replaceAll('\\', '/').split('/').at(-1) ?? '';
	return value === '' || value === '.' || value === '..' ? 'document.txt' : value;
};

/** Downloads one text file. */
export function download_text_file(file: { name: string; content: string }): void {
	const href = URL.createObjectURL(
		new Blob([file.content], {
			type: file.name.endsWith('.csv') ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8'
		})
	);
	const link = Object.assign(document.createElement('a'), { href, download: basename(file.name) });
	document.body.append(link);
	const clicked = Result.try(() => link.click());
	link.remove();
	setTimeout(() => URL.revokeObjectURL(href), 1000);
	Result.getOrThrow(clicked);
}
