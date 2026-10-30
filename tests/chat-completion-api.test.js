import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Agent, request as httpRequest } from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const fetchMock = jest.fn();
jest.unstable_mockModule('node-fetch', () => ({ default: fetchMock }));
jest.unstable_mockModule('../src/endpoints/secrets.js', () => ({
    readSecret: () => 'mock-api-key',
    SECRET_KEYS: { NANOGPT: 'nanogpt' },
}));
jest.unstable_mockModule('../src/users.js', () => ({ getCookieSecret: () => 'mock-cookie-secret' }));
jest.unstable_mockModule('../src/endpoints/google.js', () => ({
    getVertexAIAuth: jest.fn(),
    getProjectIdFromServiceAccount: jest.fn(),
}));
jest.unstable_mockModule('../src/endpoints/tokenizers.js', () => ({
    getTokenizerModel: jest.fn(),
    getSentencepiceTokenizer: jest.fn(),
    getTiktokenTokenizer: jest.fn(),
    sentencepieceTokenizers: {},
    TEXT_COMPLETION_MODELS: [],
    webTokenizers: {},
    getWebTokenizer: jest.fn(),
}));

describe('NanoGPT Chat Completion proxy', () => {
    let server;
    let baseUrl;
    let latestRequest;
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const socketObserver = () => {};
    const observedSockets = new WeakSet();
    const messages = [
        { role: 'system', content: 'Keep this system prompt verbatim.' },
        { role: 'user', name: 'User_Name', content: 'Earlier context.' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"query":"context"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'Tool result.' },
        { role: 'assistant', content: 'Previous reply.' },
        { role: 'user', content: [
            { type: 'text', text: 'Describe the picture without dropping the earlier context.' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,dGVzdA==', detail: 'low' } },
        ] },
    ];

    beforeAll(async () => {
        const { setConfigFilePath } = await import('../src/util.js');
        setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
        const { default: express } = await import('express');
        const { router } = await import('../src/endpoints/backends/chat-completions.js');
        const app = express();
        app.use(express.json());
        app.use((request, response, next) => {
            latestRequest = request;
            request.user = { directories: {} };
            if (!observedSockets.has(request.socket)) {
                request.socket.on('close', socketObserver);
                observedSockets.add(request.socket);
            }
            next();
        });
        app.use(router);
        server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
        agent.destroy();
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });

    beforeEach(() => fetchMock.mockReset());

    const makePayload = (overrides = {}) => ({
        chat_completion_source: 'nanogpt',
        model: 'provider/model-as-selected',
        messages,
        stream: false,
        max_tokens: 900,
        temperature: 0.7,
        ...overrides,
    });

    function send(payload = makePayload()) {
        return new Promise((resolve, reject) => {
            const request = httpRequest(`${baseUrl}/generate`, {
                method: 'POST', agent, headers: { 'Content-Type': 'application/json' },
            }, response => {
                let body = '';
                response.setEncoding('utf8');
                response.on('data', chunk => body += chunk);
                response.on('end', () => resolve({ status: response.statusCode, body }));
                response.on('error', reject);
            });
            request.on('error', reject);
            request.end(JSON.stringify(payload));
        });
    }

    test('preserves roles, names, tool order, multimodal content, model and generation settings', async () => {
        const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'Reply' } }] }) });
        const response = await send(makePayload({ tools, tool_choice: 'auto', top_p: 0.8, stop: ['END'], min_p: 0.05, reasoning_effort: 'max' }));
        expect(response.status).toBe(200);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe('https://nano-gpt.com/api/v1/chat/completions');
        expect(JSON.parse(options.body)).toEqual({
            messages, model: 'provider/model-as-selected', stream: false,
            max_tokens: 900, temperature: 0.7, top_p: 0.8, stop: ['END'],
            min_p: 0.05, reasoning: { effort: 'high' }, tools, tool_choice: 'auto',
        });
        expect(options.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer mock-api-key' });
        expect(options.signal.aborted).toBe(false);
        expect(latestRequest.socket.listeners('close')).toContain(socketObserver);
    });

    test.each([400, 402, 429, 503])('preserves provider error details and HTTP %s', async status => {
        const error = { message: 'Requested context exceeds the available limit.', type: 'invalid_request_error', code: 'context_length_exceeded', param: 'messages' };
        fetchMock.mockResolvedValue({ ok: false, status, statusText: 'Generic error', text: async () => JSON.stringify({ error }) });
        const response = await send();
        expect(response.status).toBe(status);
        expect(JSON.parse(response.body)).toEqual({ error, quota_error: false });
    });

    test('maps provider 401 to 400 without discarding the API-key error', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => '{"error":"Invalid API key"}' });
        const response = await send();
        expect(response.status).toBe(400);
        expect(JSON.parse(response.body).error.message).toBe('Invalid API key');
    });

    test('keeps quota classification and tolerates non-JSON upstream errors', async () => {
        fetchMock.mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests', text: async () => '{"error":{"message":"Quota exceeded","type":"insufficient_quota"}}' });
        expect(JSON.parse((await send()).body).quota_error).toBe(true);
        fetchMock.mockResolvedValueOnce({ ok: false, status: 502, statusText: 'Bad Gateway', text: async () => '<html>gateway failed</html>' });
        const response = await send();
        expect(response.status).toBe(502);
        expect(JSON.parse(response.body).error.message).toBe('Bad Gateway');
    });

    test('streams repeated requests without retaining close listeners on the keep-alive socket', async () => {
        const chunk = 'data: {"choices":[{"delta":{"content":"Reply"}}]}\n\ndata: [DONE]\n\n';
        fetchMock.mockImplementation(async () => ({ ok: true, status: 200, statusText: 'OK', body: Readable.from([chunk]) }));
        await send(makePayload({ stream: true }));
        const socket = latestRequest.socket;
        const closeListeners = socket.listenerCount('close');
        for (let index = 0; index < 12; index++) {
            const response = await send(makePayload({ stream: true }));
            expect(response.body).toBe(chunk);
            expect(latestRequest.socket).toBe(socket);
            expect(socket.listenerCount('close')).toBe(closeListeners);
        }
        expect(socket.listeners('close')).toContain(socketObserver);
        expect(fetchMock.mock.calls.every(([, options]) => !options.signal.aborted)).toBe(true);
    });

    test('aborts the upstream request when the browser cancels an active stream', async () => {
        const upstream = new PassThrough();
        let signal;
        let onStarted;
        const started = new Promise(resolve => onStarted = resolve);
        let onAborted;
        const aborted = new Promise(resolve => onAborted = resolve);
        fetchMock.mockImplementation(async (_url, options) => {
            signal = options.signal;
            signal.addEventListener('abort', onAborted, { once: true });
            onStarted();
            return { ok: true, status: 200, statusText: 'OK', body: upstream };
        });
        const pendingResponse = fetch(`${baseUrl}/generate`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(makePayload({ stream: true })),
        });
        await started;
        upstream.write('data: {"choices":[{"delta":{"content":"Started"}}]}\n\n');
        const response = await pendingResponse;
        await response.body.cancel();
        await aborted;
        expect(signal.aborted).toBe(true);
        expect(upstream.destroyed).toBe(true);
    });
});
