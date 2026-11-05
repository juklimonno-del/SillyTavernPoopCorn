import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test.describe('Prompt and API integrity', () => {
    test.beforeEach(testSetup.awaitST);

    test('rejects an over-budget prompt before submission and keeps diagnostic inspection', async ({ page }) => {
        let requests = 0;
        await page.route('**/api/backends/chat-completions/generate', route => {
            requests++;
            return route.fulfill({ json: { choices: [] } });
        });
        const result = await page.evaluate(async () => {
            const { prepareOpenAIMessages, sendOpenAIRequest, promptManager } = await import('./scripts/openai.js');
            const { eventSource, event_types } = await import('./script.js');
            const settings = promptManager.serviceSettings;
            const context = settings.openai_max_context;
            const tokens = settings.openai_max_tokens;
            let readyEvents = 0;
            const onReady = () => readyEvents++;
            eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onReady);
            settings.openai_max_context = 1;
            settings.openai_max_tokens = 1;
            const options = { extensionPrompts: {}, messages: [], messageExamples: [], charDescription: 'Mandatory character information', type: 'quiet' };
            try {
                let errorName = null;
                try {
                    const [messages] = await prepareOpenAIMessages(options, false);
                    await sendOpenAIRequest('quiet', messages);
                } catch (error) {
                    errorName = error.name;
                }
                const inspectionAvailable = Boolean(promptManager.messages);
                return { errorName, readyEvents, inspectionAvailable };
            } finally {
                settings.openai_max_context = context;
                settings.openai_max_tokens = tokens;
                eventSource.removeListener(event_types.CHAT_COMPLETION_PROMPT_READY, onReady);
            }
        });
        expect(result.errorName).toBe('TokenBudgetExceeded');
        expect(result.readyEvents).toBe(0);
        expect(result.inspectionAvailable).toBe(true);
        expect(requests).toBe(0);
    });

    test('unblocks the generation UI when prompt assembly fails', async ({ page }) => {
        let requests = 0;
        await page.route('**/api/backends/chat-completions/generate', route => {
            requests++;
            return route.fulfill({ json: { choices: [] } });
        });
        const result = await page.evaluate(async () => {
            const app = await import('./script.js');
            const { oai_settings } = await import('./scripts/openai.js');
            await app.newAssistantChat({ temporary: true });
            const originalApi = app.main_api;
            const originalContext = oai_settings.openai_max_context;
            const originalTokens = oai_settings.openai_max_tokens;
            const originalStatus = app.online_status;
            app.changeMainAPI('openai');
            app.setOnlineStatus('test');
            oai_settings.openai_max_context = 1;
            oai_settings.openai_max_tokens = 1;
            try {
                let errorName = null;
                try {
                    await app.Generate('quiet', { quiet_prompt: 'Mandatory instruction', skipWIAN: true });
                } catch (error) {
                    errorName = error.name;
                }
                return { errorName, generating: document.body.dataset.generating, sendPressed: app.is_send_press };
            } finally {
                oai_settings.openai_max_context = originalContext;
                oai_settings.openai_max_tokens = originalTokens;
                app.changeMainAPI(originalApi);
                app.setOnlineStatus(originalStatus);
            }
        });
        expect(result.errorName).toBe('TokenBudgetExceeded');
        expect(result.generating).toBeUndefined();
        expect(result.sendPressed).toBe(false);
        await expect(page.locator('#toast-container')).toContainText('Mandatory prompts exceed the context size.');
        expect(requests).toBe(0);
    });

    for (const ignored of [[], [0], [1], [2], [0, 1, 2]]) {
        test(`keeps history dense and ordered when ignoring ${JSON.stringify(ignored)}`, async ({ page }) => {
            const result = await page.evaluate(async (ignored) => {
                const { setOpenAIMessages, oai_settings } = await import('./scripts/openai.js');
                const { IGNORE_SYMBOL } = await import('./scripts/constants.js');
                const original = oai_settings.names_behavior;
                oai_settings.names_behavior = -1; // No name prefixes
                try {
                    const chat = ['first', 'second', 'third'].map((mes, index) => ({
                        mes, name: 'Test', is_user: index !== 1, extra: { [IGNORE_SYMBOL]: ignored.includes(index) },
                    }));
                    const messages = setOpenAIMessages(chat);
                    return { content: messages.map(message => message.content), dense: [...messages.keys()].every(index => index in messages) };
                } finally {
                    oai_settings.names_behavior = original;
                }
            }, ignored);
            expect(result.dense).toBe(true);
            expect(result.content).toEqual(['first', 'second', 'third'].filter((_, index) => !ignored.includes(index)).reverse());
        });
    }

    for (const source of ['MAKERSUITE', 'VERTEXAI']) {
        test(`preserves mixed response parts and reasoning from ${source}`, async ({ page }) => {
            const result = await page.evaluate(async (source) => {
                const { getStreamingReply, chat_completion_sources } = await import('./scripts/openai.js');
                const state = { reasoning: '', images: [], signature: '' };
                const text = getStreamingReply({ candidates: [{ content: { parts: [
                    { inlineData: { mimeType: 'image/png', data: 'aW1n' } },
                    { text: 'First', thought: true },
                    { text: ' thought', thought: true },
                    { text: 'Hello', thoughtSignature: 'signature' },
                    { functionCall: { name: 'lookup', args: {} } },
                    { text: ' world' },
                ] } }] }, state, { chatCompletionSource: chat_completion_sources[source], overrideShowThoughts: true });
                return { text, state };
            }, source);
            expect(result.text).toBe('Hello world');
            expect(result.state.reasoning).toBe('First thought');
            expect(result.state.signature).toBe('signature');
            expect(result.state.images).toEqual(['data:image/png;base64,aW1n']);
        });
    }

    test('extracts both Claude structured output formats and reports malformed native JSON', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { extractJsonFromData } = await import('./script.js');
            const { chat_completion_sources } = await import('./scripts/openai.js');
            const options = { mainApi: 'openai', chatCompletionSource: chat_completion_sources.CLAUDE };
            const native = { content: [{ type: 'text', text: '{"answer":42}' }] };
            const tool = { content: [{ type: 'tool_use', input: { answer: 42 } }] };
            const invalid = { content: [{ type: 'text', text: 'not JSON' }] };
            let errorMessage = null;
            try {
                extractJsonFromData(invalid, options);
            } catch (error) {
                errorMessage = error.message;
            }
            return {
                native: extractJsonFromData(native, options),
                tool: extractJsonFromData(tool, options),
                raw: extractJsonFromData(invalid, { ...options, returnInvalidJson: true }),
                errorMessage,
            };
        });
        expect(JSON.parse(result.native)).toEqual({ answer: 42 });
        expect(result.tool).toBe(result.native);
        expect(result.raw).toBe('not JSON');
        expect(result.errorMessage).toContain('invalid JSON');
    });

    test('routes every bundled streaming choice by its index', async ({ page }) => {
        const frames = [
            { choices: [{ index: 2, delta: { content: 'C' } }, { index: 0, delta: { content: 'A' } }, { index: 1, delta: { content: 'B' } }] },
            { choices: [{ index: 1, delta: { content: '2' } }, { index: 0, delta: { content: '1' } }, { index: 2, delta: { content: '3' } }] },
            { choices: [] },
        ];
        await page.route('**/api/backends/chat-completions/generate', route => route.fulfill({
            contentType: 'text/event-stream', body: frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
        }));
        const result = await page.evaluate(async () => {
            const { oai_settings, chat_completion_sources, sendOpenAIRequest } = await import('./scripts/openai.js');
            Object.assign(oai_settings, { chat_completion_source: chat_completion_sources.CUSTOM, custom_model: 'test', stream_openai: true, n: 3, reverse_proxy: '' });
            const stream = await sendOpenAIRequest('normal', [{ role: 'user', content: 'Hello' }]);
            let last;
            for await (const value of stream()) last = value;
            return { text: last.text, swipes: last.swipes };
        });
        expect(result).toEqual({ text: 'A1', swipes: ['B2', 'C3'] });
    });

    test('propagates an API error after partial streaming output', async ({ page }) => {
        await page.route('**/api/backends/chat-completions/generate', route => route.fulfill({
            contentType: 'text/event-stream',
            body: 'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\ndata: {"error":{"message":"upstream failed"}}\n\n',
        }));
        const result = await page.evaluate(async () => {
            const { oai_settings, chat_completion_sources, sendOpenAIRequest } = await import('./scripts/openai.js');
            Object.assign(oai_settings, { chat_completion_source: chat_completion_sources.CUSTOM, custom_model: 'test', stream_openai: true, n: 1, reverse_proxy: '' });
            const stream = await sendOpenAIRequest('normal', [{ role: 'user', content: 'Hello' }]);
            let text = '';
            try {
                for await (const value of stream()) text = value.text;
                return { text, error: null };
            } catch (error) {
                return { text, error: error.message };
            }
        });
        expect(result).toEqual({ text: 'partial', error: 'upstream failed' });
    });
});
