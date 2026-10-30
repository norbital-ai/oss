// The one HTML writer every ingest reader feeds. Readers build blocks of sanitised inline HTML (text escaped here,
// only strong/em/code/br/time), so the output can hold nothing outside the allowed set:
//   h1-6 p ul ol li table thead tbody tr th td(colspan rowspan) pre code br strong em time img(src alt)
//   section(data-page|data-slide|data-speaker data-start data-end)
// Every block element opens on its own line (a leaf closes on the same line), so the engine windows by line; a
// `<table>` or `<section>` runs from its opening line to its closing one.
export type Cell = { header: boolean; colspan: number; rowspan: number; blocks: Block[] };
export type Block =
	| { t: 'h'; level: number; html: string }
	| { t: 'p'; html: string }
	| { t: 'pre'; text: string }
	| { t: 'list'; ordered: boolean; items: Block[][] }
	| { t: 'table'; rows: Cell[][] }
	| { t: 'img'; src: string; alt: string }
	/** One transcript segment: who spoke, from when to when (seconds), what. */
	| { t: 'turn'; speaker: string; start: number; end: number; html: string }
	| { t: 'section'; kind: 'page' | 'slide'; n: number; blocks: Block[] };
export type Image = { name: string; mime: string; bytes: string };

export const escape = (s: string) =>
	s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
/** Wraps already-escaped inline HTML in strong/em; empty runs vanish rather than leave empty wrappers. */
export const inline = (html: string, f: { strong?: boolean; em?: boolean; code?: boolean }) => {
	if (!html.trim()) return html;
	let s = html;
	if (f.code) s = `<code>${s}</code>`;
	if (f.em) s = `<em>${s}</em>`;
	if (f.strong) s = `<strong>${s}</strong>`;
	return s;
};

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export class Images {
	readonly list: Image[] = [];
	/** Stores the bytes as the next `image-n.<ext>` and returns the name to reference. */
	add(bytes: Uint8Array, mime: string) {
		const name = `image-${this.list.length + 1}.${EXT[mime] ?? 'bin'}`;
		this.list.push({ name, mime, bytes: Buffer.from(bytes).toString('base64') });
		return name;
	}
}

const one = (html: string) => html.replace(/\s*\n\s*/g, ' ');
const seconds = (s: number) => String(Math.round(s * 10) / 10);

export function write(blocks: Block[]): string {
	const lines: string[] = [];
	const leaf = (open: string, html: string, close: string) => lines.push(`${open}${one(html)}${close}`);
	const emit = (b: Block) => {
		switch (b.t) {
			case 'h': {
				const level = Math.min(Math.max(b.level, 1), 6);
				return leaf(`<h${level}>`, b.html, `</h${level}>`);
			}
			case 'p':
				return leaf('<p>', b.html, '</p>');
			case 'pre':
				lines.push('<pre>', ...escape(b.text.replace(/\r\n?/g, '\n').replace(/\n$/, '')).split('\n'), '</pre>');
				return;
			case 'turn': {
				const t = Math.floor(b.start);
				const hms = [t / 3600, (t % 3600) / 60, t % 60].map((n) => String(Math.floor(n)).padStart(2, '0')).join(':');
				return leaf(
					`<section data-speaker="${escape(b.speaker)}" data-start="${seconds(b.start)}" data-end="${seconds(b.end)}"><time>${hms}</time> `,
					b.html,
					'</section>'
				);
			}
			case 'img':
				return lines.push(`<img src="${escape(b.src)}" alt="${escape(b.alt)}">`);
			case 'list': {
				const tag = b.ordered ? 'ol' : 'ul';
				lines.push(`<${tag}>`);
				for (const item of b.items) container('li', '', item);
				return lines.push(`</${tag}>`);
			}
			case 'section':
				lines.push(`<section data-${b.kind}="${b.n}">`);
				b.blocks.forEach(emit);
				return lines.push('</section>');
			case 'table': {
				lines.push('<table>');
				const head = b.rows.findIndex((r) => !r.every((c) => c.header));
				const split = head === -1 ? b.rows.length : head;
				const group = (tag: string, rows: Cell[][]) => {
					if (rows.length === 0) return;
					lines.push(`<${tag}>`);
					for (const row of rows) {
						lines.push('<tr>');
						for (const c of row) {
							const attrs =
								(c.colspan > 1 ? ` colspan="${c.colspan}"` : '') +
								(c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : '');
							container(c.header ? 'th' : 'td', attrs, c.blocks);
						}
						lines.push('</tr>');
					}
					lines.push(`</${tag}>`);
				};
				group('thead', b.rows.slice(0, split));
				group('tbody', b.rows.slice(split));
				return lines.push('</table>');
			}
		}
	};
	/** A cell or item holding one paragraph is one line; anything more opens and closes on lines of its own. */
	const container = (tag: string, attrs: string, inner: Block[]) => {
		const only = inner.length === 1 ? inner[0] : undefined;
		if (inner.length === 0) return lines.push(`<${tag}${attrs}></${tag}>`);
		if (only?.t === 'p') return leaf(`<${tag}${attrs}>`, only.html, `</${tag}>`);
		lines.push(`<${tag}${attrs}>`);
		inner.forEach(emit);
		lines.push(`</${tag}>`);
	};
	blocks.forEach(emit);
	return lines.join('\n');
}
