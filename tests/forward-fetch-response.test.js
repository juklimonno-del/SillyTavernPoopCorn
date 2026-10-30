import { describe, expect, test } from '@jest/globals';
import { PassThrough, Writable } from 'node:stream';
import { forwardFetchResponse } from '../src/util.js';

function makeDestination() {
    let text = '';
    const destination = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
    destination.socket = {};
    return { destination, text: () => text };
}

describe('forwardFetchResponse lifecycle', () => {
    test('resolves only after the entire response is forwarded', async () => {
        const body = new PassThrough();
        const { destination, text } = makeDestination();
        let completed = false;
        const pending = forwardFetchResponse({ ok: true, status: 200, statusText: 'OK', body }, destination)
            .then(() => completed = true);
        body.write('first');
        await new Promise(resolve => setImmediate(resolve));
        expect(completed).toBe(false);
        body.end('last');
        await pending;
        expect(text()).toBe('firstlast');
        expect(destination.writableFinished).toBe(true);
    });

    test('closes a failed upstream without making callers send to a destroyed response', async () => {
        const body = new PassThrough();
        const { destination } = makeDestination();
        const pending = forwardFetchResponse({ ok: true, status: 200, statusText: 'OK', body }, destination);
        body.destroy(new Error('upstream stream failed'));
        await expect(pending).resolves.toBeUndefined();
        expect(destination.destroyed).toBe(true);
    });

    test('destroys the upstream stream when the downstream response closes early', async () => {
        const body = new PassThrough();
        const { destination } = makeDestination();
        const pending = forwardFetchResponse({ ok: true, status: 200, statusText: 'OK', body }, destination);
        destination.destroy();
        await expect(pending).resolves.toBeUndefined();
        expect(body.destroyed).toBe(true);
    });

    test('preserves streaming error text and maps unauthorized status without Basic-auth reset', async () => {
        const { destination, text } = makeDestination();
        await forwardFetchResponse({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => '{"error":"Invalid API key"}' }, destination);
        expect(destination.statusCode).toBe(400);
        expect(text()).toBe('{"error":"Invalid API key"}');
    });
});
