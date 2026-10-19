// CodeMirror extensions and Lezer trees carry runtime identities shared by every editor import.
export const EDITOR_SINGLETONS = [
	'codemirror',
	'@codemirror/state',
	'@codemirror/view',
	'@codemirror/language',
	'@codemirror/autocomplete',
	'@codemirror/commands',
	'@codemirror/lint',
	'@codemirror/search',
	'@codemirror/lang-javascript',
	'@codemirror/lang-json',
	'@lezer/common',
	'@lezer/highlight',
	'@lezer/lr',
	'@lezer/javascript',
	'@lezer/json'
];
