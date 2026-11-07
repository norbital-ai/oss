// Which reader a file goes to: by its mime type, then its name's extension, never a guess at its contents.
export type Kind = 'pdf' | 'document' | 'slides' | 'sheets' | 'text' | 'image' | 'audio';
type Reader = 'html' | 'office' | 'libreoffice' | 'workbook' | 'pdf' | 'pre' | 'csv' | 'json' | 'image' | 'audio';
const FORMATS: Record<string, { mime: string; kind: Kind; reader: Reader }> = {
	pdf: { mime: 'application/pdf', kind: 'pdf', reader: 'pdf' },
	doc: { mime: 'application/msword', kind: 'document', reader: 'office' },
	rtf: { mime: 'application/rtf', kind: 'document', reader: 'libreoffice' },
	docx: {
		mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		kind: 'document',
		reader: 'office'
	},
	odt: { mime: 'application/vnd.oasis.opendocument.text', kind: 'document', reader: 'libreoffice' },
	html: { mime: 'text/html', kind: 'document', reader: 'html' },
	ppt: { mime: 'application/vnd.ms-powerpoint', kind: 'slides', reader: 'libreoffice' },
	pptx: {
		mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
		kind: 'slides',
		reader: 'office'
	},
	odp: { mime: 'application/vnd.oasis.opendocument.presentation', kind: 'slides', reader: 'libreoffice' },
	xls: { mime: 'application/vnd.ms-excel', kind: 'sheets', reader: 'workbook' },
	xlsx: {
		mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		kind: 'sheets',
		reader: 'workbook'
	},
	ods: { mime: 'application/vnd.oasis.opendocument.spreadsheet', kind: 'sheets', reader: 'libreoffice' },
	csv: { mime: 'text/csv', kind: 'sheets', reader: 'csv' },
	tsv: { mime: 'text/tab-separated-values', kind: 'sheets', reader: 'csv' },
	json: { mime: 'application/json', kind: 'sheets', reader: 'json' },
	txt: { mime: 'text/plain', kind: 'text', reader: 'pre' },
	png: { mime: 'image/png', kind: 'image', reader: 'image' },
	jpg: { mime: 'image/jpeg', kind: 'image', reader: 'image' },
	gif: { mime: 'image/gif', kind: 'image', reader: 'image' },
	webp: { mime: 'image/webp', kind: 'image', reader: 'image' }
};
const ALIAS: Record<string, string> = {
	htm: 'html',
	jpeg: 'jpg',
	md: 'txt',
	text: 'txt',
	'text/rtf': 'rtf',
	'application/xhtml+xml': 'html',
	'text/markdown': 'txt',
	'image/jpg': 'jpg'
};
const BY_MIME = new Map(Object.entries(FORMATS).map(([ext, f]) => [f.mime, ext]));
const AUDIO = /^(mp3|m4a|wav|ogg|oga|opus|flac|aac|weba|webm|mp4)$/;
/** Containers whose audio track the transcriber can read (mp4, m4a, webm, ogg); other video containers are refused. */
const CONTAINER = /^(mp4|m4a|webm|ogg)$/;
const NO_PARSER = 'no parser: build a tool for it with your workspace tools';

export type Route =
	| { ok: true; ext: string; kind: Kind; reader: Reader; mime: string }
	| { ok: false; message: string };
/** The format of a file by its mime type, then its name's extension; never a guess at contents. */
export function route(name: string, mime: string): Route {
	const type = mime.split(';')[0]!.trim().toLowerCase();
	const dot = name.lastIndexOf('.');
	const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
	const media = /^(audio|video)\/([\w.+-]+)$/.exec(type);
	if (type.startsWith('audio/') || (AUDIO.test(ext) && (type === '' || type === 'application/octet-stream' || media)))
		return media?.[1] === 'video' && !CONTAINER.test(media[2] === 'quicktime' ? 'mov' : media[2]!)
			? { ok: false, message: NO_PARSER }
			: { ok: true, ext, kind: 'audio', reader: 'audio', mime: type };
	const found =
		BY_MIME.get(type) ??
		ALIAS[type] ??
		(type === '' || type === 'application/octet-stream' ? (ALIAS[ext] ?? ext) : undefined);
	const format = found === undefined ? undefined : FORMATS[found];
	if (!format || type.startsWith('video/'))
		return { ok: false, message: NO_PARSER };
	return { ok: true, ext: found!, ...format };
}

/** A file these readers take goes to an engine from the disk: its bytes are never read here. */
export const fromDisk = (reader: Reader) =>
	reader === 'office' || reader === 'libreoffice' || reader === 'workbook' || reader === 'pdf';
