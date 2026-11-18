import { Marked } from 'marked';

// Markdown to HTML for `ReadonlyMarkdown`: GFM; raw HTML in the text is shown as text, and a link or image may only point
// at http(s), mailto or a relative path, so a stored document can never script the page that shows it.
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const prettyJson = (text: string): string | undefined => {
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return undefined;
	}
};
const marked = new Marked({
	gfm: true,
	async: false,
	renderer: {
		html: ({ text }) => escape(text),
		// A JSON fence is shown as JSON, not one dense line: the schema/transcript prompts are written to be read.
		code: ({ text, lang }) => {
			const json = lang?.toLowerCase() === 'json' ? prettyJson(text) : undefined;
			const body = escape(json ?? text);
			return `<pre><code${lang === undefined || lang === '' ? '' : ` class="language-${escape(lang)}"`}>${body}</code></pre>`;
		},
		// Only a same-origin image loads: a remote one would fetch on render, so text an agent wrote could leak data in its
		// URL with no click. It shows as a link the person may follow.
		image: ({ href, text }) =>
			/^(\.{1,2}\/|\/(?![/\\]))/.test(href)
				? false
				: `<a href="${escape(href)}" rel="noopener noreferrer nofollow" target="_blank">${escape(text || href)}</a>`
	},
	walkTokens(token) {
		if (
			(token.type === 'link' || token.type === 'image') &&
			!/^(https?:|mailto:|[#/.])/i.test(token.href)
		)
			token.href = '#';
	}
});
/** Markdown to HTML; `breaks` keeps each typed newline a line break. */
export const markdown_html = (text: string, breaks: boolean): string =>
	marked.parse(text, { async: false, breaks });
