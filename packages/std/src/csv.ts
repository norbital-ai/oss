/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF, LF or CR rows; a trailing newline adds no row. `delimiter` is one character (`,` by default; `\t` reads TSV). */
export function csvRows(text: string, delimiter = ','): string[][] {
	const rows: string[][] = [];
	let row: string[] = [],
		cell = '',
		quoted = false,
		rowStart = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (quoted) {
			if (ch === '"' && text[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (ch === '"') quoted = false;
			else cell += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === delimiter) {
			row.push(cell);
			cell = '';
		} else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && text[i + 1] === '\n') i++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = '';
			rowStart = i + 1;
		} else cell += ch;
	}
	if (rowStart < text.length) rows.push([...row, cell]);
	return rows;
}

const DELIMITERS = [',', ';', '\t', '|'] as const;
/**
 * The delimiter of a CSV text: whichever of `,` `;` tab `|` its header line (the first line, outside quotes) holds most
 * often; `,` when it holds none. A spreadsheet saved in a locale with a decimal comma writes `;`.
 */
export function csvDelimiter(text: string): (typeof DELIMITERS)[number] {
	const counts = new Map<string, number>();
	let quoted = false;
	for (const ch of text) {
		if (ch === '"') quoted = !quoted;
		else if (!quoted && (ch === '\n' || ch === '\r')) break;
		else if (!quoted) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	}
	let best: (typeof DELIMITERS)[number] = ',';
	for (const d of DELIMITERS) if ((counts.get(d) ?? 0) > (counts.get(best) ?? 0)) best = d;
	return best;
}

/**
 * A CSV file's bytes as text: a byte-order mark names UTF-8, UTF-16LE or UTF-16BE (and is dropped); otherwise UTF-8 when
 * the bytes are valid UTF-8, else Windows-1252 (what Excel writes on Western-locale Windows).
 */
export function csvText(bytes: Uint8Array): string {
	const [a, b, c] = bytes;
	if (a === 0xef && b === 0xbb && c === 0xbf)
		return new TextDecoder('utf-8').decode(bytes.subarray(3));
	if (a === 0xff && b === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
	if (a === 0xfe && b === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return new TextDecoder('windows-1252').decode(bytes);
	}
}

/** Rows as RFC 4180 CSV (CRLF rows): a field holding the delimiter, a quote or a line break is quoted, quotes doubled; `null` is empty. */
export const csvOf = (
	rows: readonly (readonly (string | number | boolean | null)[])[],
	delimiter = ','
): string =>
	rows
		.map((r) =>
			r
				.map((v) => {
					const s = v === null ? '' : String(v);
					return s.includes(delimiter) || /["\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
				})
				.join(delimiter)
		)
		.join('\r\n');
