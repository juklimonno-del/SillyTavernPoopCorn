import { describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { parseOllamaStream } from '../src/ollama-stream.js';

function makeClient() {
    const request = { socket: new EventEmitter() };
    const response = {
        headersSent: false,
        chunks: [],
        setHeader: jest.fn(),
        status: jest.fn(function (code) { this.statusCode = code; return this; }),
        json: jest.fn(function (data) { this.payload = data; }),
        write(data) { this.headersSent = true; this.chunks.push(data); },
        end(data) { if (data) this.chunks.push(data); },
    };
    return { request, response };
}

function events(response) {
    return response.chunks.join('').split('\n\n').filter(Boolean).map(line => line.slice(6)).map(data => data === '[DONE]' ? data : JSON.parse(data));
}

describe('Ollama stream conversion', () => {
    test('reads multiple records in one chunk and a final record without a newline', async () => {
        const { request, response } = makeClient();
        const body = Readable.from([Buffer.from('{"response":"one"}\n{"response":"two","thinking":"thought"}\n{"response":"three"}')]);
        await parseOllamaStream({ ok: true, body }, request, response);
        expect(events(response)).toEqual([
            { choices: [{ text: 'one', thinking: '' }] },
            { choices: [{ text: 'two', thinking: 'thought' }] },
            { choices: [{ text: 'three', thinking: '' }] },
            '[DONE]',
        ]);
        expect(request.socket.listenerCount('close')).toBe(0);
    });

    test('preserves UTF-8 characters and JSON records split across chunks', async () => {
        const { request, response } = makeClient();
        const data = Buffer.from('{"response":"a😀é"}\r\n\n{"done":true}\n');
        const body = Readable.from([...data].map(byte => Buffer.from([byte])));
        await parseOllamaStream({ ok: true, body }, request, response);
        expect(events(response)).toEqual([{ choices: [{ text: 'a😀é', thinking: '' }] }, '[DONE]']);
    });

    test('forwards upstream HTTP failures without a success marker', async () => {
        const { request, response } = makeClient();
        await parseOllamaStream({ ok: false, status: 404, statusText: 'Not Found', text: async () => '{"error":"model missing"}' }, request, response);
        expect(response.statusCode).toBe(404);
        expect(response.chunks.join('')).toBe('{"error":"model missing"}');
    });

    for (const data of ['{"error":"model failed"}\n', 'not json\n']) {
        test(`reports an error before the first token: ${data}`, async () => {
            const { request, response } = makeClient();
            await parseOllamaStream({ ok: true, body: Readable.from([Buffer.from(data)]) }, request, response);
            expect(response.status).toHaveBeenCalledWith(502);
            expect(response.payload.error.message).toBeTruthy();
            expect(events(response)).toEqual([]);
        });
    }

    test('reports a failed record after output without marking the stream successful', async () => {
        const { request, response } = makeClient();
        const body = Readable.from([Buffer.from('{"response":"partial"}\n{"error":"generation failed"}\n')]);
        await parseOllamaStream({ ok: true, body }, request, response);
        expect(events(response)).toEqual([
            { choices: [{ text: 'partial', thinking: '' }] },
            { error: { message: 'generation failed' } },
        ]);
    });

    test('reports transport failures after output', async () => {
        const { request, response } = makeClient();
        const body = Readable.from((async function* () {
            yield Buffer.from('{"response":"partial"}\n');
            throw new Error('connection lost');
        })());
        await parseOllamaStream({ ok: true, body }, request, response);
        expect(events(response).at(-1)).toEqual({ error: { message: 'connection lost' } });
        expect(events(response)).not.toContain('[DONE]');
    });

    test('destroys the upstream and removes its listener when the client disconnects', async () => {
        const { request, response } = makeClient();
        const body = new PassThrough();
        const finished = parseOllamaStream({ ok: true, body }, request, response);
        request.socket.emit('close');
        await finished;
        expect(body.destroyed).toBe(true);
        expect(events(response)).toEqual([]);
        expect(request.socket.listenerCount('close')).toBe(0);
    });
});
