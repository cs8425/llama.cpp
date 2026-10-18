// N11.1 / N11.3 — the shared `extra → parts` builder (N11 D1) and the DB→API
// conversion matrix, with the REAL ChatService (the Svelte stores and the
// canvas-based image capping are mocked — node has no canvas).
//
// Pins the KV-cache prefix contract:
// - tool results rebuild the exact parts the agentic in-flow push sent
//   (byte-identical — the old early-return dropped `extra`, e.g. MCP
//   screenshot base64, N11.1 P0);
// - assistant + tool_calls + empty content omits the content field (aligned
//   with the in-flow `content || undefined`);
// - the compact request is the last live payload's byte-prefix + instruction
//   (N11.2 / A4: `buildLlmContext(effectivePath).messages` + instruction).
// The two wire captures in context-enhance/ are root-cause documentation only
// (the fixed wire shape intentionally changed) — these synthetic fixtures are
// the regression oracle.

import { AttachmentType, ContentPartType, FileTypeAudio, MessageRole, MessageType } from '$lib/enums';
import { ChatService } from '$lib/services/chat.service';
import { buildLlmContext, effectiveCompactionPath } from '$lib/services/context/context-builder';
import { settingsStore } from '$lib/stores/settings/index.svelte';
import type {
	ApiChatMessageData,
	ApiChatMessageContentPart
} from '$lib/types/api';
import type {
	DatabaseMessage,
	DatabaseMessageExtra,
	DatabaseMessageExtraAudioFile,
	DatabaseMessageExtraImageFile
} from '$lib/types/database';
import { capImageDataURLSize } from '$lib/utils/cap-img-size';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/models/index.svelte', () => ({
	modelsStore: { props: { modelSupportsVision: vi.fn(() => true) } }
}));

vi.mock('$lib/stores/settings/index.svelte', () => ({
	settingsStore: { getConfig: vi.fn(() => 2) }
}));

vi.mock('$lib/utils/cap-img-size', () => ({
	// node has no canvas: passthrough that tags its output so a capped url is
	// distinguishable from the original.
	capImageDataURLSize: vi.fn(async (url: string) => `${url}#capped`)
}));

const AUDIO_B64 = 'QUFBQUFB';
const SCREENSHOT = 'data:image/png;base64,AAAABBBB';

let seq = 0;

function message(role: MessageRole, content: string, extra?: Partial<DatabaseMessage>): DatabaseMessage {
	seq += 1;

	return {
		children: [],
		content,
		convId: 'c1',
		id: `m${seq}`,
		parent: null,
		role,
		timestamp: seq,
		type: MessageType.TEXT,
		...extra
	} as DatabaseMessage;
}

function screenshotExtra(): DatabaseMessageExtraImageFile {
	return { base64Url: SCREENSHOT, name: 'screenshot.png', type: AttachmentType.IMAGE };
}

function audioExtra(): DatabaseMessageExtraAudioFile {
	return { base64Data: AUDIO_B64, mimeType: 'audio/mpeg', name: 'note.mp3', type: AttachmentType.AUDIO };
}

function imagePart(url: string = `${SCREENSHOT}#capped`): ApiChatMessageContentPart {
	return { image_url: { url }, type: ContentPartType.IMAGE_URL };
}

function audioPart(): ApiChatMessageContentPart {
	return { input_audio: { data: AUDIO_B64, format: FileTypeAudio.MP3 }, type: ContentPartType.INPUT_AUDIO };
}

function textPart(text: string): ApiChatMessageContentPart {
	return { text, type: ContentPartType.TEXT };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(settingsStore.getConfig).mockReturnValue(2);
});

describe('buildExtraContentParts (N11 D1 shared builder)', () => {
	it('emits parts in the fixed user-input order, independent of the input order', async () => {
		const parts = await ChatService.buildExtraContentParts({
			content: 'hello',
			extra: [
				{ base64Data: AUDIO_B64, mimeType: 'audio/mpeg', name: 'note.mp3', type: AttachmentType.AUDIO },
				{ base64Data: 'VTN', mimeType: 'video/mp4', name: 'v.mp4', type: AttachmentType.VIDEO },
				{
					base64Data: 'UERGLQ',
					content: 'pdf text',
					images: ['data:image/png;base64,p1', 'data:image/png;base64,p2'],
					name: 'd.pdf',
					processedAsImages: true,
					type: AttachmentType.PDF
				},
				{ content: 'mc', name: 'p', promptName: 'pn', serverName: 'srv', type: AttachmentType.MCP_PROMPT },
				{ content: 'rc', name: 'r', serverName: 'srv', uri: 'u', type: AttachmentType.MCP_RESOURCE },
				{ base64Url: SCREENSHOT, name: 'shot.png', type: AttachmentType.IMAGE },
				{ content: 'const a = 1;', name: 'x.ts', type: AttachmentType.TEXT },
				{ content: 'pasted', name: 'paste.txt', type: AttachmentType.LEGACY_CONTEXT }
			]
		});

		// text files, legacy context, images, audio, content text, video, PDF
		// pages, MCP prompt, MCP resource
		expect(parts).toEqual([
			textPart('\n\n--- File: x.ts ---\nconst a = 1;'),
			textPart('\n\n--- File: paste.txt ---\npasted'),
			imagePart(),
			audioPart(),
			textPart('hello'),
			{ input_video: { data: 'VTN', format: 'mp4' }, type: ContentPartType.INPUT_VIDEO },
			imagePart('data:image/png;base64,p1'),
			imagePart('data:image/png;base64,p2'),
			textPart('\n\n--- MCP Prompt: p (srv) ---\nmc'),
			textPart('\n\n--- MCP Resource: r (srv) ---\nrc')
		]);
	});

	it('caps every IMAGE extra at the configured resolution (PDF pages untouched)', async () => {
		const parts = await ChatService.buildExtraContentParts({
			content: '',
			extra: [
				{ base64Url: 'data:image/png;base64,one', name: 'a.png', type: AttachmentType.IMAGE },
				{ base64Url: 'data:image/jpeg;base64,two', name: 'b.jpg', type: AttachmentType.IMAGE },
				{
					base64Data: 'UERGLQ',
					content: 'pdf text',
					images: ['data:image/png;base64,p1'],
					name: 'd.pdf',
					processedAsImages: true,
					type: AttachmentType.PDF
				}
			]
		});

		expect(capImageDataURLSize).toHaveBeenCalledTimes(2);
		expect(capImageDataURLSize).toHaveBeenNthCalledWith(1, 'data:image/png;base64,one', 2);
		expect(capImageDataURLSize).toHaveBeenNthCalledWith(2, 'data:image/jpeg;base64,two', 2);
		expect(parts).toEqual([
			imagePart('data:image/png;base64,one#capped'),
			imagePart('data:image/jpeg;base64,two#capped'),
			imagePart('data:image/png;base64,p1')
		]);
	});

	it('returns no parts for empty content and no attachments', async () => {
		expect(await ChatService.buildExtraContentParts({ content: '', extra: [] })).toEqual([]);
	});
});

describe('convertDbMessageToApiChatMessageData (N11.1 tool result matrix)', () => {
	it('tool result without extra → plain string content + tool_call_id', async () => {
		const m = message(MessageRole.TOOL, 'file content here', { toolCallId: 'c1' });

		await expect(ChatService.convertDbMessageToApiChatMessageData(m)).resolves.toEqual({
			content: 'file content here',
			role: MessageRole.TOOL,
			tool_call_id: 'c1'
		});
	});

	it('tool result with a screenshot → the image part is kept (P0 regression)', async () => {
		const m = message(MessageRole.TOOL, 'screenshot attached', {
			extra: [screenshotExtra()],
			toolCallId: 'c1'
		});

		await expect(ChatService.convertDbMessageToApiChatMessageData(m)).resolves.toEqual({
			content: [imagePart(), textPart('screenshot attached')],
			role: MessageRole.TOOL,
			tool_call_id: 'c1'
		});
	});

	it('tool result with audio → [audio, text]', async () => {
		const m = message(MessageRole.TOOL, 'recording attached', {
			extra: [audioExtra()],
			toolCallId: 'c1'
		});

		await expect(ChatService.convertDbMessageToApiChatMessageData(m)).resolves.toEqual({
			content: [audioPart(), textPart('recording attached')],
			role: MessageRole.TOOL,
			tool_call_id: 'c1'
		});
	});

	it('tool result with image + audio → [image, audio, text] (fixed order)', async () => {
		const m = message(MessageRole.TOOL, 'both attached', {
			// input order reversed on purpose: the builder reorders
			extra: [audioExtra(), screenshotExtra()],
			toolCallId: 'c1'
		});

		await expect(ChatService.convertDbMessageToApiChatMessageData(m)).resolves.toEqual({
			content: [imagePart(), audioPart(), textPart('both attached')],
			role: MessageRole.TOOL,
			tool_call_id: 'c1'
		});
	});

	it('tool result with image and empty content → [image] only', async () => {
		const m = message(MessageRole.TOOL, '', {
			extra: [screenshotExtra()],
			toolCallId: 'c1'
		});

		await expect(ChatService.convertDbMessageToApiChatMessageData(m)).resolves.toEqual({
			content: [imagePart()],
			role: MessageRole.TOOL,
			tool_call_id: 'c1'
		});
	});

	it('user message with extra → parts (unchanged behavior)', async () => {
		const m = message(MessageRole.USER, 'see the shot', { extra: [screenshotExtra()] });

		await expect(ChatService.convertDbMessageToApiChatMessageData(m)).resolves.toEqual({
			content: [imagePart(), textPart('see the shot')],
			role: MessageRole.USER
		});
	});
});

describe('empty content serialization (N11.1, three states)', () => {
	it(
		'assistant + tool_calls + empty content → the content field is omitted (in-flow aligned)',
		async () => {
		const m = message(MessageRole.ASSISTANT, '', {
			toolCalls: JSON.stringify([{ function: { name: 'read_file' }, id: 'c1', type: 'function' }])
		});
		const r = await ChatService.convertDbMessageToApiChatMessageData(m);

		expect(r.tool_calls).toHaveLength(1);
		// JSON.stringify drops the undefined property: the wire shape matches
		// the in-flow `content: turnContent || undefined` push
		expect(JSON.stringify(r)).not.toContain('"content"');
	});

	it('assistant + tool_calls + text → the content is kept', async () => {
		const m = message(MessageRole.ASSISTANT, 'on it', {
			toolCalls: JSON.stringify([{ function: { name: 'read_file' }, id: 'c1', type: 'function' }])
		});
		const r = await ChatService.convertDbMessageToApiChatMessageData(m);

		expect(r.content).toBe('on it');
		expect(JSON.stringify(r)).toContain('"content":"on it"');
	});

	it('assistant without tool_calls + empty content → content "" is kept', async () => {
		const r = await ChatService.convertDbMessageToApiChatMessageData(message(MessageRole.ASSISTANT, ''));

		expect(r.content).toBe('');
		expect(JSON.stringify(r)).toContain('"content":""');
	});
});

describe('in-flow ≡ DB rebuild (byte-identity, N11.1)', () => {
	/** The agentic in-flow tool result push (agentic/index.svelte.ts:1168–1177) verbatim. */
	async function inFlowToolResult(
		attachments: DatabaseMessageExtra[],
		cleanedResult: string,
		toolCallId: string
	): Promise<ApiChatMessageData> {
		const contentParts = await ChatService.buildExtraContentParts({ content: cleanedResult, extra: attachments });

		return {
			content: contentParts.length <= 1 ? cleanedResult : contentParts,
			role: MessageRole.TOOL,
			tool_call_id: toolCallId
		};
	}

	it('screenshot + audio tool result: identical wire shape', async () => {
		const attachments = [screenshotExtra(), audioExtra()];
		const cleanedResult = 'screenshot attached';
		const db = message(MessageRole.TOOL, cleanedResult, { extra: attachments, toolCallId: 'c1' });

		const inFlow = await inFlowToolResult(attachments, cleanedResult, 'c1');
		const rebuilt = await ChatService.convertDbMessageToApiChatMessageData(db);

		expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(inFlow));
	});

	it('audio-only tool result: identical wire shape', async () => {
		const attachments = [audioExtra()];
		const cleanedResult = 'recording attached';
		const db = message(MessageRole.TOOL, cleanedResult, { extra: attachments, toolCallId: 'c1' });

		const inFlow = await inFlowToolResult(attachments, cleanedResult, 'c1');
		const rebuilt = await ChatService.convertDbMessageToApiChatMessageData(db);

		expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(inFlow));
	});

	it('tool result without attachments: plain string both ways', async () => {
		const cleanedResult = 'plain result';
		const db = message(MessageRole.TOOL, cleanedResult, { toolCallId: 'c1' });

		const inFlow = await inFlowToolResult([], cleanedResult, 'c1');
		const rebuilt = await ChatService.convertDbMessageToApiChatMessageData(db);

		expect(inFlow.content).toBe('plain result');
		expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(inFlow));
	});
});

/** The user's capture scenario, synthesized: an agentic turn whose tool result
 * carries an MCP screenshot (data URL image) + audio. */
function screenshotPath(): DatabaseMessage[] {
	const sys = message(MessageRole.SYSTEM, 'be terse');
	const u1 = message(MessageRole.USER, 'check the app');
	const a1 = message(MessageRole.ASSISTANT, '', {
		toolCalls: JSON.stringify([
			{ function: { arguments: '{}', name: 'mcp_screenshot' }, id: 'c1', type: 'function' }
		])
	});
	const t1 = message(MessageRole.TOOL, 'screenshot attached', {
		extra: [screenshotExtra(), audioExtra()],
		toolCallId: 'c1'
	});
	const u2 = message(MessageRole.USER, 'now fix it');

	return [sys, u1, a1, t1, u2];
}

describe('compact request = last live payload byte-prefix + instruction (N11.2 / A4)', () => {
	it('first compaction: the prefix is the full pre-compaction payload', async () => {
		const path = screenshotPath();
		const lastPayload = (await buildLlmContext(path)).messages;

		// the P0 regression: the screenshot parts survive the DB rebuild
		const toolLine = lastPayload.find((m) => m.role === MessageRole.TOOL);

		expect(toolLine?.content).toEqual([imagePart(), audioPart(), textPart('screenshot attached')]);

		const compactRequest = [
			...lastPayload,
			{ content: 'INSTRUCTION', role: MessageRole.USER }
		];

		expect(JSON.stringify(compactRequest.slice(0, -1))).toBe(JSON.stringify(lastPayload));
	});

	it(
		'second compaction: the prefix is the post-compaction payload [sys, old summary, kept]',
		async () => {
		const path = screenshotPath();
		const u2 = path[path.length - 1];
		const cmp = message(MessageRole.USER, 'OLD SUMMARY', {
			compactionMeta: { firstKeptMessageId: u2.id, summarizedCount: 3 },
			type: MessageType.COMPACTION
		});
		const pathAfterFirst = [...path, cmp];

		// the last live payload (sent on the turn after the first compaction)
		const lastPayload = (await buildLlmContext(pathAfterFirst)).messages;

		expect(lastPayload.map(({ role }) => role)).toEqual([
			MessageRole.SYSTEM,
			MessageRole.USER,
			MessageRole.USER
		]);

		// the second compaction's planning input = the effective path
		const planPath = effectiveCompactionPath(pathAfterFirst);

		expect(planPath.map((m) => m.id)).toEqual([path[0].id, cmp.id, u2.id]);

		const compactRequest = [
			...(await buildLlmContext(planPath)).messages,
			{ content: 'INSTRUCTION', role: MessageRole.USER }
		];

		// the KV cache built by the last payload survives the compact request
		expect(JSON.stringify(compactRequest.slice(0, -1))).toBe(JSON.stringify(lastPayload));
	});
});
