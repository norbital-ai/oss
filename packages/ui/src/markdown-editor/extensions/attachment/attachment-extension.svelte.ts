import type { IFileUploadClient, UploadStage } from '../../../file-upload/index.js';
import type {
	AllowedFileType as TAllowedFileType,
	FileMetadata as TFileMetadata
} from '../../../file-value/index.js';
import { safeParse } from '@norbital-ai/std';
import type { MessageVars } from '@norbital-ai/std/i18n';
import type { Command, CommandProps, NodeViewRenderer, NodeViewRendererProps } from '@tiptap/core';
import { Node, mergeAttributes } from '@tiptap/core';
import type { Transaction as ProsemirrorTransaction } from '@tiptap/pm/state';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as ProsemirrorNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { mount } from 'svelte';
import { toast } from 'svelte-sonner';
import { z } from 'zod';
import AttachmentView from './attachment-view.svelte';

const fileMetadataSchema: z.ZodType<TFileMetadata> = z.object({
	summary: z.string(),
	structure_hint: z.string()
});

export interface FileAttachmentMetadata {
	name: string;
	url: string;
	type: TAllowedFileType;
	size: number;
	metadata?: TFileMetadata;
	norbital_id?: string;
	indexed_status?: string;
}

export interface FileAttachmentAttributes extends FileAttachmentMetadata {
	id: string | null;
	uploading: boolean;
	uploadError: boolean;
	stage: UploadStage | null;
}

interface FileAttachmentOptions {
	HTMLAttributes: Record<string, unknown>;
	allowedFiletypes: TAllowedFileType[];
	translate?: (key: string, vars?: MessageVars) => string;
}

interface FileAttachmentCommandAttrs {
	file: File;
}

const generateId = (): string => {
	return Math.random().toString(36).substring(2, 15);
};

type FileAttachmentStorage = {
	uploadClient: IFileUploadClient;
};

function getUploadClient(storage: unknown): IFileUploadClient {
	return (storage as FileAttachmentStorage).uploadClient;
}

function findFileAttachmentPosition(
	doc: ProsemirrorNode,
	extensionName: string,
	id: string
): number | null {
	let pos: number | null = null;
	doc.descendants((node, p) => {
		if (node.type.name === extensionName && node.attrs.id === id) {
			pos = p;
			return false;
		}
		return true;
	});
	return pos;
}

function createAttachmentAttrs(
	id: string,
	file: File,
	overrides: Record<string, unknown> = {}
): Record<string, unknown> {
	return {
		id,
		name: file.name,
		type: file.type as TAllowedFileType,
		size: file.size,
		url: null,
		metadata: null,
		norbital_id: null,
		indexed_status: null,
		uploading: true,
		uploadError: false,
		stage: 'uploading',
		...overrides
	};
}

function startAttachmentUpload(args: {
	uploadClient: IFileUploadClient;
	file: File;
	id: string;
	updateNode: (attrs: Record<string, unknown>) => void;
}): void {
	const { uploadClient, file, id, updateNode } = args;
	const { promise } = uploadClient.beginUpload(file, { uploadId: id });

	void promise
		.then((result) => {
			updateNode(
				createAttachmentAttrs(id, file, {
					url: result.url,
					metadata: result.metadata as TFileMetadata | undefined,
					norbital_id: result.norbital_id ?? null,
					indexed_status: result.indexed_status ?? null,
					uploading: false,
					uploadError: false,
					stage: 'complete'
				})
			);
		})
		.catch((error: unknown) => {
			if (error instanceof Error && error.name === 'AbortError') {
				updateNode(
					createAttachmentAttrs(id, file, {
						uploading: false,
						uploadError: false,
						stage: 'aborted'
					})
				);
				return;
			}

			console.error('File upload error:', error);
			updateNode(
				createAttachmentAttrs(id, file, {
					uploading: false,
					uploadError: true,
					stage: 'error'
				})
			);
		});
}

declare module '@tiptap/core' {
	interface Commands<ReturnType> {
		fileAttachment: {
			setFileAttachment: (attrs: FileAttachmentCommandAttrs) => ReturnType;
		};
	}
}

export function extractFileMetadata(node: ProsemirrorNode): FileAttachmentMetadata | null {
	if (node.type.name !== 'fileAttachment') return null;

	return {
		name: node.attrs.name,
		url: node.attrs.url,
		type: node.attrs.type as TAllowedFileType,
		size: node.attrs.size,
		metadata: node.attrs.metadata,
		norbital_id: node.attrs.norbital_id,
		indexed_status: node.attrs.indexed_status
	};
}

export function createFileAttachmentExtension(options: {
	client: IFileUploadClient;
	translate?: (key: string, vars?: MessageVars) => string;
}) {
	const injectedClient = options.client;
	const injectedTranslate = options.translate;

	return Node.create<FileAttachmentOptions>({
		name: 'fileAttachment',
		group: 'block',
		marks: '',
		// @ts-ignore allowGapCursor is valid on TipTap nodes
		allowGapCursor: true,
		selectable: true,
		addAttributes() {
			return {
				name: {
					default: 'File',
					parseHTML: (element) => element.getAttribute('data-name') || 'File',
					renderHTML: (attributes) => ({ 'data-name': attributes.name })
				},
				type: {
					default: 'application/octet-stream' as TAllowedFileType,
					parseHTML: (element) =>
						(element.getAttribute('data-type') as TAllowedFileType) ||
						('application/octet-stream' as TAllowedFileType),
					renderHTML: (attributes) => ({ 'data-type': attributes.type })
				},
				size: {
					default: 0,
					parseHTML: (element) => parseInt(element.getAttribute('data-size') || '0', 10),
					renderHTML: (attributes) => ({
						'data-size': attributes.size.toString()
					})
				},
				url: {
					default: null,
					parseHTML: (element) => element.getAttribute('data-url'),
					renderHTML: (attributes) => ({ 'data-url': attributes.url })
				},
				metadata: {
					default: null,
					parseHTML: (element) => {
						const data = element.getAttribute('data-metadata');
						if (!data) return null;
						const result = fileMetadataSchema.safeParse(safeParse(data));
						return result.success ? result.data : null;
					},
					renderHTML: (attributes) => ({
						'data-metadata': attributes.metadata ? JSON.stringify(attributes.metadata) : null
					})
				},
				norbital_id: {
					default: null,
					parseHTML: (element) => element.getAttribute('data-norbital-id') || null,
					renderHTML: (attributes) => ({ 'data-norbital-id': attributes.norbital_id })
				},
				indexed_status: {
					default: null,
					parseHTML: (element) => element.getAttribute('data-indexed-status') || null,
					renderHTML: (attributes) => ({
						'data-indexed-status': attributes.indexed_status
					})
				},
				id: {
					default: null
				},
				uploading: {
					default: true
				},
				uploadError: {
					default: false
				},
				stage: {
					default: null
				}
			};
		},

		addStorage() {
			return {
				uploadClient: injectedClient
			};
		},

		addOptions() {
			return {
				HTMLAttributes: {},
				translate: injectedTranslate,
				allowedFiletypes: [
					'application/pdf',
					'text/csv',
					'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
					'application/vnd.ms-excel',
					'application/json',
					'text/plain',
					'image/png',
					'image/jpeg',
					'image/webp'
				] as TAllowedFileType[]
			};
		},

		parseHTML() {
			return [{ tag: 'div.file-attachment[data-file-attachment]' }];
		},

		renderHTML({ HTMLAttributes }) {
			return [
				'div',
				mergeAttributes(
					{ class: 'file-attachment', 'data-file-attachment': 'true' },
					this.options.HTMLAttributes,
					HTMLAttributes
				)
			];
		},

		addNodeView(): NodeViewRenderer {
			return (props: NodeViewRendererProps) => {
				const dom = document.createElement('div');
				dom.setAttribute('contenteditable', 'false');

				const componentProps = $state({
					editor: props.editor,
					node: props.node,
					getPos: props.getPos
				});

				mount(AttachmentView, {
					target: dom,
					props: componentProps
				});

				return {
					dom,
					update: (updatedNode: ProsemirrorNode) => {
						componentProps.node = updatedNode;
						return true;
					}
				};
			};
		},

		addCommands() {
			return {
				setFileAttachment:
					(attrs: FileAttachmentCommandAttrs): Command =>
					({ editor, chain }: CommandProps) => {
						const { file } = attrs;
						const uploadClient = getUploadClient(this.storage);

						if (!this.options.allowedFiletypes.includes(file.type as TAllowedFileType)) {
							toast.error(
								this.options.translate?.('misc.fileTypeNotAllowed', { type: file.type }) ??
									`File type ${file.type} is not allowed.`
							);
							return false;
						}

						const id = generateId();

						const updateNode = (attrs: Record<string, unknown>) => {
							const pos = findFileAttachmentPosition(editor.state.doc, this.name, id);
							if (pos !== null) {
								editor.commands.command(({ tr }: { tr: ProsemirrorTransaction }) => {
									tr.setNodeMarkup(pos, undefined, attrs);
									return true;
								});
							}
						};

						const insertResult = chain()
							.insertContent({
								type: this.name,
								attrs: createAttachmentAttrs(id, file)
							})
							.focus()
							.run();

						if (insertResult) {
							startAttachmentUpload({ uploadClient, file, id, updateNode });
						}

						return insertResult;
					}
			};
		},

		addProseMirrorPlugins() {
			const pluginKey = new PluginKey('fileAttachmentDrop');
			const cleanupKey = new PluginKey('fileAttachmentCleanup');
			// eslint-disable-next-line @typescript-eslint/no-this-alias
			const extension = this;

			return [
				new Plugin({
					key: cleanupKey,
					appendTransaction(transactions: readonly ProsemirrorTransaction[], oldState, newState) {
						if (!transactions.some((t) => t.docChanged)) return null;
						const uploadClient = getUploadClient(extension.storage);

						const newKeys = new Set<string>();
						newState.doc.descendants((node) => {
							if (node.type.name !== extension.name) return true;
							const id = node.attrs.id as string | null | undefined;
							const url = node.attrs.url as string | null | undefined;
							if (id) newKeys.add(`id:${id}`);
							if (url) newKeys.add(`url:${url}`);
							return true;
						});

						oldState.doc.descendants((node) => {
							if (node.type.name !== extension.name) return true;
							const id = node.attrs.id as string | null | undefined;
							const url = node.attrs.url as string | null | undefined;
							const keyId = id ? `id:${id}` : null;
							const keyUrl = url ? `url:${url}` : null;

							const stillExists = (keyId && newKeys.has(keyId)) || (keyUrl && newKeys.has(keyUrl));
							if (stillExists) return true;

							// Cancel in-flight uploads when nodes leave the doc (composer
							// clear, undo, etc). Do NOT delete persisted URLs here — that
							// would wipe session uploads after send when the draft clears.
							// Explicit user remove calls delete() from AttachmentView.removeFile.
							if (id) {
								uploadClient.cancel(id);
							}

							return true;
						});

						return null;
					}
				}),
				new Plugin({
					key: pluginKey,
					props: {
						handleDrop(view: EditorView, event: DragEvent) {
							if (!event.dataTransfer?.files.length) {
								return false;
							}
							const uploadClient = getUploadClient(extension.storage);

							const coords = view.posAtCoords({
								left: event.clientX,
								top: event.clientY
							});
							if (!coords) return false;

							const files = Array.from(event.dataTransfer.files);
							files.forEach((file) => {
								if (!extension.options.allowedFiletypes.includes(file.type as TAllowedFileType)) {
									toast.warning(
										extension.options.translate?.('misc.fileTypeNotAllowed', { type: file.type }) ??
											`File type ${file.type} is not allowed.`
									);
									return;
								}

								const id = generateId();

								const updateNode = (attrs: Record<string, unknown>) => {
									const pos = findFileAttachmentPosition(view.state.doc, extension.name, id);
									if (pos !== null) {
										view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, attrs));
									}
								};

								const node = view.state.schema.nodes.fileAttachment.create({
									...createAttachmentAttrs(id, file)
								});

								view.dispatch(view.state.tr.insert(coords.pos, node));

								startAttachmentUpload({ uploadClient, file, id, updateNode });
							});

							return true;
						}
					}
				})
			];
		}
	});
}
