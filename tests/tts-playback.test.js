import { describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import vm from 'node:vm';
import { setMaxListeners } from 'node:events';

// Run the production audio controller with a fake media element. This avoids
// importing provider UIs and models while exercising the real playback code.
const source = fs.readFileSync(new URL('../public/scripts/extensions/tts/index.js', import.meta.url), 'utf8');
const start = source.indexOf('let audioElement = new Audio();');
const end = source.indexOf('globalThis.tts_preview =', start);
if (start < 0 || end < 0) throw new Error('Could not locate the TTS audio controller');

function createController({ getBase64Async = async () => 'data:audio/wav;base64,AA==', vrmLipSync } = {}) {
    class FakeAudio extends EventTarget {
        src = '';
        play = jest.fn();
        constructor() {
            super();
            setMaxListeners(0, this);
        }
    }
    const settings = { tts: { playback_rate: 1.25 }, vrm: { enabled: !!vrmLipSync } };
    const complete = jest.fn();
    const controller = vm.runInNewContext(`${source.slice(start, end)}
        ({ audioElement, playAudioData, setCurrentJob(job) { currentAudioJob = job; } });`, {
        Audio: FakeAudio,
        Blob,
        console: { debug: jest.fn(), log: jest.fn() },
        extension_settings: settings,
        completeCurrentAudioJob: complete,
        getBase64Async,
        vrmLipSync,
    });
    return { ...controller, settings, complete };
}

describe('TTS playback lifecycle', () => {
    test('does not accumulate canplay listeners across audio chunks', async () => {
        const controller = createController();
        for (let i = 0; i < 100; i++) {
            const job = { audioBlob: `/audio/${i}.wav`, char: 'Alice' };
            controller.setCurrentJob(job);
            await controller.playAudioData(job);
        }
        controller.audioElement.dispatchEvent(new Event('canplay'));
        expect(controller.audioElement.play).toHaveBeenCalledTimes(1);
        expect(controller.audioElement.playbackRate).toBe(1.25);
        controller.settings.tts.playback_rate = 0.75;
        controller.audioElement.dispatchEvent(new Event('canplay'));
        expect(controller.audioElement.play).toHaveBeenCalledTimes(2);
        expect(controller.audioElement.playbackRate).toBe(0.75);
        controller.audioElement.dispatchEvent(new Event('ended'));
        expect(controller.complete).toHaveBeenCalledTimes(1);
    });

    test('does not start an already cancelled job', async () => {
        const controller = createController();
        controller.setCurrentJob(null);
        await controller.playAudioData({ audioBlob: '/audio/cancelled.wav', char: 'Alice' });
        expect(controller.audioElement.src).toBe('');
    });

    test('does not overwrite a newer job when base64 conversion finishes', async () => {
        let finishConversion;
        const controller = createController({
            getBase64Async: () => new Promise(resolve => { finishConversion = resolve; }),
        });
        const oldJob = { audioBlob: new Blob(['old'], { type: 'audio/wav' }), char: 'Alice' };
        controller.setCurrentJob(oldJob);
        const preparing = controller.playAudioData(oldJob);
        const newJob = { audioBlob: '/audio/new.wav', char: 'Bob' };
        controller.setCurrentJob(newJob);
        await controller.playAudioData(newJob);
        finishConversion('data:audio/wav;base64,b2xk');
        await preparing;
        expect(controller.audioElement.src).toBe('/audio/new.wav');
    });

    test('does not resume a job stopped during lip-sync preparation', async () => {
        let finishLipSync;
        let enterLipSync;
        const enteredLipSync = new Promise(resolve => { enterLipSync = resolve; });
        const lipSync = jest.fn(() => new Promise(resolve => {
            finishLipSync = resolve;
            enterLipSync();
        }));
        const controller = createController({ vrmLipSync: lipSync });
        const job = { audioBlob: new Blob(['old'], { type: 'audio/wav' }), char: 'Alice' };
        controller.setCurrentJob(job);
        const preparing = controller.playAudioData(job);
        await enteredLipSync;
        expect(lipSync).toHaveBeenCalledTimes(1);
        controller.setCurrentJob(null);
        finishLipSync();
        await preparing;
        expect(controller.audioElement.src).toBe('');
    });
});
