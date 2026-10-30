import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.route('**/script.js', async route => {
        const response = await route.fetch();
        const body = (await response.text()).replace('await eventSource.emit(event_types.APP_READY);', 'await eventSource.emit(event_types.APP_READY); window.__completionTestReady = true;');
        await route.fulfill({ response, body });
    });
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const body = await response.json();
        const settings = JSON.parse(body.settings);
        settings.firstRun = false;
        body.settings = JSON.stringify(settings);
        await route.fulfill({ response, json: body });
    });
    // Every generation below uses an in-page synthetic stream. Never send a real
    // generation if the mock or request URL changes.
    await page.route('**/api/backends/chat-completions/generate', route => route.abort());
    await page.goto('/');
    await page.waitForFunction(() => window.__completionTestReady);
});

test('stream errors throw readable messages without treating successful message events as errors', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { tryParseStreamingError } = await import('/scripts/openai.js');
        const errors = [];
        for (const payload of [
            { error: { message: 'Synthetic context limit', code: 'context_length_exceeded' } },
            { message: 'Synthetic rate limit' },
            { detail: 'Synthetic provider failure' },
        ]) {
            try {
                tryParseStreamingError({ ok: true }, JSON.stringify(payload), { quiet: true });
            } catch (error) {
                errors.push(error.message);
            }
        }
        tryParseStreamingError({ ok: true }, JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [] } }), { quiet: true });
        tryParseStreamingError({ ok: true }, '[DONE]', { quiet: true });
        return errors;
    });
    expect(result).toEqual(['Synthetic context limit', 'Synthetic rate limit', 'Synthetic provider failure']);
});

test('NanoGPT client preserves messages and cancels streams on DONE, provider error and consumer stop', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { sendOpenAIRequest, oai_settings } = await import('/scripts/openai.js');
        const { power_user } = await import('/scripts/power-user.js');
        const originalSettings = { ...oai_settings };
        const originalSmooth = power_user.smooth_streaming;
        const originalFetch = window.fetch;
        const messages = [
            { role: 'system', content: 'Keep the complete system instruction.' },
            { role: 'user', name: 'User_Name', content: 'Previous context.' },
            { role: 'assistant', content: 'Previous response.' },
            { role: 'user', content: [{ type: 'text', text: 'Current request.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,dGVzdA==' } }] },
        ];
        const runs = [];
        try {
            Object.assign(oai_settings, { chat_completion_source: 'nanogpt', nanogpt_model: 'provider/test-model', stream_openai: true });
            power_user.smooth_streaming = false;
            for (const mode of ['done', 'error', 'stop']) {
                let cancellations = 0;
                let payload;
                window.fetch = async (url, options) => {
                    if (url !== '/api/backends/chat-completions/generate') return originalFetch(url, options);
                    payload = JSON.parse(options.body);
                    const data = ':data: heartbeat, not JSON\n\ndata: {"choices":[{"delta":{"content":"Hello"}}]}\n\n';
                    const tail = mode === 'done' ? 'data: [DONE]\n\n' : mode === 'error' ? 'data: {"error":{"message":"Synthetic context limit"}}\n\n' : '';
                    return new Response(new ReadableStream({
                        start(controller) { controller.enqueue(new TextEncoder().encode(data + tail)); },
                        cancel() { cancellations++; },
                    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
                };
                let failure = null;
                const replies = [];
                try {
                    const stream = await sendOpenAIRequest('normal', messages);
                    for await (const item of stream()) {
                        replies.push(item.text);
                        if (mode === 'stop') break;
                    }
                } catch (error) {
                    failure = error.message;
                }
                runs.push({ mode, cancellations, failure, replies, messages: payload.messages, model: payload.model, source: payload.chat_completion_source });
            }
            return { messages, runs };
        } finally {
            window.fetch = originalFetch;
            Object.assign(oai_settings, originalSettings);
            power_user.smooth_streaming = originalSmooth;
        }
    });
    expect(result.runs).toHaveLength(3);
    for (const run of result.runs) {
        expect(run.cancellations).toBe(1);
        expect(run.replies).toEqual(['Hello']);
        expect(run.messages).toEqual(result.messages);
        expect(run.model).toBe('provider/test-model');
        expect(run.source).toBe('nanogpt');
        expect(run.failure).toBe(run.mode === 'error' ? 'Synthetic context limit' : null);
    }
});

test('custom request services close streams when the consumer or provider stops generation', async ({ page }) => {
    const runs = await page.evaluate(async () => {
        const { ChatCompletionService, TextCompletionService } = await import('/scripts/custom-request.js');
        const originalFetch = window.fetch;
        const results = [];
        try {
            for (const Service of [ChatCompletionService, TextCompletionService]) {
                for (const mode of ['done', 'error', 'stop']) {
                    let cancellations = 0;
                    window.fetch = async (url, options) => {
                        if (!String(url).includes('/generate')) return originalFetch(url, options);
                        const chunk = 'data: {"choices":[{"delta":{"content":"Hello"},"text":"Hello"}]}\n\n';
                        const tail = mode === 'done' ? 'data: [DONE]\n\n' : mode === 'error' ? 'data: {"error":{"message":"Synthetic provider failure"}}\n\n' : '';
                        return new Response(new ReadableStream({
                            start(controller) { controller.enqueue(new TextEncoder().encode(chunk + tail)); },
                            cancel() { cancellations++; },
                        }), { status: 200 });
                    };
                    const stream = await Service.sendRequest({ stream: true, chat_completion_source: 'nanogpt', messages: [], prompt: '' });
                    let failure = null;
                    const replies = [];
                    try {
                        for await (const item of stream()) {
                            replies.push(item.text);
                            if (mode === 'stop') break;
                        }
                    } catch (error) {
                        failure = error.message;
                    }
                    results.push({ service: Service.TYPE, mode, cancellations, replies, failure });
                }
            }
            return results;
        } finally {
            window.fetch = originalFetch;
        }
    });
    expect(runs).toHaveLength(6);
    for (const run of runs) {
        expect(run.cancellations).toBe(1);
        expect(run.replies).toEqual(['Hello']);
        expect(run.failure).toBe(run.mode === 'error' ? 'Synthetic provider failure' : null);
    }
});

test('mandatory prompt budget failure blocks generation, releases the UI, and remains inspectable in a dry run', async ({ page }) => {
    // Do not persist the temporary API selection or any synthetic chat state.
    await page.route('**/api/settings/save', route => route.fulfill({ json: { result: 'ok' } }));
    await page.route('**/api/chats/save', route => route.fulfill({ json: { result: 'ok' } }));
    // eslint-disable-next-line playwright/no-force-option -- The API selector is in a collapsed drawer; this test exercises generation, not drawer navigation.
    await page.selectOption('#main_api', 'openai', { force: true });
    const result = await page.evaluate(async () => {
        const script = await import('/script.js');
        const { prepareOpenAIMessages, oai_settings, promptManager } = await import('/scripts/openai.js');
        const originalSettings = { ...oai_settings };
        const originalCounter = promptManager.tokenHandler.countAsync;
        const originalFetch = window.fetch;
        const originalStatus = script.online_status;
        let requests = 0;
        try {
            Object.assign(oai_settings, { chat_completion_source: 'nanogpt', nanogpt_model: 'provider/test-model', openai_max_context: 1, openai_max_tokens: 1 });
            // Deterministic token counts; the real builder still allocates all
            // mandatory prompts and detects the insufficient context budget.
            promptManager.tokenHandler.countAsync = async () => 10;
            script.setOnlineStatus('synthetic-test-model');
            window.fetch = async (url, options) => {
                if (String(url).includes('/api/backends/chat-completions/generate')) {
                    requests++;
                    throw new Error('A partial prompt must never be sent');
                }
                return originalFetch(url, options);
            };
            const options = {
                charDescription: 'Mandatory character context.', extensionPrompts: {},
                messages: [{ role: 'user', content: 'Question' }], messageExamples: [], type: 'quiet',
            };
            const inspected = await prepareOpenAIMessages(structuredClone(options), true);
            let builderFailure = null;
            try {
                await prepareOpenAIMessages(structuredClone(options), false);
            } catch (error) {
                builderFailure = error.name;
            }
            let generationFailure = null;
            try {
                await script.Generate('quiet', { quiet_prompt: 'Mandatory synthetic instruction.', skipWIAN: true });
            } catch (error) {
                generationFailure = error.name;
            }
            return {
                builderFailure, generationFailure, requests,
                inspectable: Array.isArray(inspected[0]),
                generating: document.body.dataset.generating,
                sendPressed: script.is_send_press,
            };
        } finally {
            window.fetch = originalFetch;
            promptManager.tokenHandler.countAsync = originalCounter;
            Object.assign(oai_settings, originalSettings);
            script.setOnlineStatus(originalStatus);
        }
    });
    expect(result.builderFailure).toBe('TokenBudgetExceeded');
    expect(result.generationFailure).toBe('TokenBudgetExceeded');
    expect(result.requests).toBe(0);
    expect(result.inspectable).toBe(true);
    expect(result.generating).toBeUndefined();
    expect(result.sendPressed).toBe(false);
});
