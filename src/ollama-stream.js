import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { forwardFetchResponse } from './util.js';

/**
 * Convert Ollama's newline-delimited JSON response into completion SSE events.
 * @param {import('node-fetch').Response} upstream Upstream response
 * @param {import('express').Request} request Client request
 * @param {import('express').Response} response Client response
 * @returns {Promise<void>}
 */
export async function parseOllamaStream(upstream, request, response) {
    let disconnected = false;
    const onClose = () => {
        disconnected = true;
        if (upstream.body instanceof Readable) upstream.body.destroy();
    };

    try {
        if (!upstream.ok) {
            await forwardFetchResponse(upstream, response);
            return;
        }
        if (!upstream.body) throw new Error('No body in the response');

        response.setHeader('Content-Type', 'text/event-stream');
        request.socket.once('close', onClose);
        const decoder = new StringDecoder('utf8');
        let pending = '';

        const writeRecord = (line) => {
            if (!line.trim()) return;
            const json = JSON.parse(line);
            if (json.error) throw new Error(typeof json.error === 'string' ? json.error : JSON.stringify(json.error));

            const text = json.response || '';
            const thinking = json.thinking || '';
            if (text || thinking) {
                response.write(`data: ${JSON.stringify({ choices: [{ text, thinking }] })}\n\n`);
            }
        };

        for await (const chunk of upstream.body) {
            pending += decoder.write(chunk);
            let newline;
            while ((newline = pending.indexOf('\n')) !== -1) {
                writeRecord(pending.slice(0, newline));
                pending = pending.slice(newline + 1);
            }
        }
        pending += decoder.end();
        if (disconnected) return;
        writeRecord(pending);
        response.end('data: [DONE]\n\n');
    } catch (error) {
        if (disconnected) return;
        console.error('Error forwarding Ollama response:', error);
        const payload = { error: { message: error.message || 'Ollama stream failed' } };
        if (!response.headersSent) {
            response.setHeader('Content-Type', 'application/json');
            response.status(502).json(payload);
        } else {
            response.end(`data: ${JSON.stringify(payload)}\n\n`);
        }
    } finally {
        request.socket.removeListener('close', onClose);
    }
}
