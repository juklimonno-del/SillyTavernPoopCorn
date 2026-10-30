/* eslint-disable playwright/no-standalone-expect -- Jest test.each callbacks are test scopes. */
import { describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/scripts/extensions/tts/index.js', import.meta.url), 'utf8');
function productionSection(start, end) {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first);
    if (first < 0 || last < 0) throw new Error(`Could not locate production TTS code: ${start}`);
    return source.slice(first, last);
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

// Run the real worker/refresh functions with controllable network and extension
// events, so a provider switch can occur at each asynchronous boundary.
function createLifecycle(provider, emit = jest.fn(async () => {})) {
    const settings = { tts: { pass_asterisks: true }, rvc: { enabled: false } };
    const hooks = {
        saveSettingsDebounced: jest.fn(), setTtsStatus: jest.fn(),
        initVoiceMap: jest.fn(), updateVoiceMap: jest.fn(),
        toastr: { error: jest.fn(), info: jest.fn() },
    };
    const controller = vm.runInNewContext(`
        let ttsProvider = initialProvider, ttsProviderName = 'First';
        let providerLoadVersion = 0, providerLoading = false;
        let currentTtsJob = null, audioPaused = false;
        const audioJobQueue = [], ttsJobQueue = [];
        const voiceMap = { Alice: 'First Voice' };
        ${productionSection('async function addAudioJob(', 'async function processAudioJobQueue(')}
        ${productionSection('function completeTtsJob()', 'function joinQuotedBlocks(')}
        ${productionSection('function onRefreshClick()', 'function onEnableClick()')}
        ({ tts, addAudioJob, onRefreshClick, processTtsQueue,
            startJob: job => currentTtsJob = job,
            enqueue: job => ttsJobQueue.push(job),
            switchProvider: (provider, job = null) => {
                providerLoadVersion++;
                ttsProvider = provider;
                ttsProviderName = 'Second';
                providerLoading = !provider;
                currentTtsJob = job;
                audioJobQueue.length = 0;
                ttsJobQueue.length = 0;
            },
            state: () => ({ currentTtsJob, audioJobQueue, ttsJobQueue }) });
    `, {
        initialProvider: provider, extension_settings: settings, ...hooks,
        eventSource: { emit }, event_types: {
            TTS_JOB_STARTED: 'start', TTS_AUDIO_READY: 'audio', TTS_JOB_COMPLETE: 'complete',
        },
        DEFAULT_VOICE_MARKER: 'default', DISABLED_VOICE_MARKER: 'disabled',
        substituteParams: value => value, power_user: { allow_name2_display: true },
        console: { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn(), log: jest.fn() },
    });
    return { ...controller, ...hooks, settings, emit };
}

describe('TTS provider lifecycle during asynchronous work', () => {
    test('a switch during the start event cannot generate with either provider or finish a new job', async () => {
        const started = deferred();
        const first = { generateTts: jest.fn() };
        const second = { generateTts: jest.fn() };
        const lifecycle = createLifecycle(first, jest.fn(() => started.promise));
        lifecycle.startJob({ id: 1, name: 'Alice' });
        const pending = lifecycle.tts('Hello', 'voice', 'Alice');
        const newJob = { id: 2, name: 'Bob' };
        lifecycle.switchProvider(second, newJob);
        started.resolve();
        await pending;
        expect(first.generateTts).not.toHaveBeenCalled();
        expect(second.generateTts).not.toHaveBeenCalled();
        expect(lifecycle.state().currentTtsJob).toBe(newJob);
        expect(lifecycle.emit).toHaveBeenCalledTimes(1);
    });

    test('a switch during audio decoding cannot queue audio or emit ready/complete events', async () => {
        const decoded = deferred();
        const entered = deferred();
        const first = { generateTts: jest.fn(async () => ({ blob: () => { entered.resolve(); return decoded.promise; } })) };
        const lifecycle = createLifecycle(first);
        lifecycle.startJob({ id: 1, name: 'Alice' });
        const pending = lifecycle.tts('Hello', 'voice', 'Alice');
        await entered.promise;
        lifecycle.switchProvider(undefined);
        decoded.resolve({ type: 'audio/mpeg' });
        await pending;
        expect(lifecycle.state().audioJobQueue).toHaveLength(0);
        expect(lifecycle.emit.mock.calls.map(([type]) => type)).toEqual(['start']);
    });

    test('an unchanged provider still generates, queues audio, emits events and completes its job', async () => {
        const first = { generateTts: jest.fn(async () => 'audio-url') };
        const lifecycle = createLifecycle(first);
        lifecycle.startJob({ id: 1, name: 'Alice' });
        await lifecycle.tts('Hello', 'voice', 'Alice');
        expect(first.generateTts).toHaveBeenCalledWith('Hello', 'voice', null);
        expect(lifecycle.state().audioJobQueue).toEqual([{ audioBlob: 'audio-url', char: 'Alice' }]);
        expect(lifecycle.emit.mock.calls.map(([type]) => type)).toEqual(['start', 'audio', 'complete']);
        expect(lifecycle.state().currentTtsJob).toBeNull();
    });

    test.each(['resolve', 'reject'])('a stale refresh cannot save settings or change status when it %ss', async outcome => {
        const refreshed = deferred();
        const first = { settings: { voice: 'old' }, onRefreshClick: () => refreshed.promise };
        const lifecycle = createLifecycle(first);
        const pending = lifecycle.onRefreshClick();
        lifecycle.switchProvider({ settings: { voice: 'new' } });
        refreshed[outcome](outcome === 'reject' ? new Error('Old provider offline') : undefined);
        await pending;
        expect(lifecycle.settings.tts.First).toBeUndefined();
        expect(lifecycle.settings.tts.Second).toBeUndefined();
        expect(lifecycle.saveSettingsDebounced).not.toHaveBeenCalled();
        expect(lifecycle.setTtsStatus).not.toHaveBeenCalled();
        expect(lifecycle.toastr.error).not.toHaveBeenCalled();
        expect(lifecycle.initVoiceMap).not.toHaveBeenCalled();
    });

    test('refresh saves settings normally when the selected provider stays current', async () => {
        const first = { settings: { voice: 'current' }, onRefreshClick: async () => {} };
        const lifecycle = createLifecycle(first);
        await lifecycle.onRefreshClick();
        expect(lifecycle.settings.tts.First).toBe(first.settings);
        expect(lifecycle.saveSettingsDebounced).toHaveBeenCalledTimes(1);
        expect(lifecycle.setTtsStatus).toHaveBeenCalledWith('Successfully applied settings', true);
        expect(lifecycle.initVoiceMap).toHaveBeenCalledTimes(1);
    });

    test('a voice lookup completing after a switch cannot start old text on the new provider', async () => {
        const voice = deferred();
        const first = { getVoice: jest.fn(() => voice.promise), generateTts: jest.fn() };
        const second = { generateTts: jest.fn() };
        const lifecycle = createLifecycle(first);
        lifecycle.enqueue({ name: 'Alice', segmentType: 'other', segmentText: 'Old text' });
        const pending = lifecycle.processTtsQueue();
        const newJob = { id: 2, name: 'Bob' };
        lifecycle.switchProvider(second, newJob);
        voice.resolve({ voice_id: 'old-voice' });
        await pending;
        expect(first.getVoice).toHaveBeenCalledWith('First Voice');
        expect(first.generateTts).not.toHaveBeenCalled();
        expect(second.generateTts).not.toHaveBeenCalled();
        expect(lifecycle.state().currentTtsJob).toBe(newJob);
        expect(lifecycle.emit).not.toHaveBeenCalled();
    });

    test.each(['resolve', 'reject'])('text preprocessing that %ss after a switch leaves the new job and queue intact', async outcome => {
        const processed = deferred();
        const first = { processText: jest.fn(() => processed.promise) };
        const lifecycle = createLifecycle(first);
        lifecycle.enqueue({ name: 'Alice', mes: 'Old text' });
        const pending = lifecycle.processTtsQueue();
        const newJob = { id: 2, name: 'Bob' };
        const newQueuedJob = { id: 3, name: 'Bob', mes: 'New text' };
        lifecycle.switchProvider({}, newJob);
        lifecycle.enqueue(newQueuedJob);
        processed[outcome](outcome === 'reject' ? new Error('Old preprocessing failed') : 'Processed old text');
        await pending;
        expect(first.processText).toHaveBeenCalledWith('Old text');
        expect(lifecycle.state().currentTtsJob).toBe(newJob);
        expect(lifecycle.state().ttsJobQueue).toEqual([newQueuedJob]);
        expect(lifecycle.toastr.error).not.toHaveBeenCalled();
    });
});
