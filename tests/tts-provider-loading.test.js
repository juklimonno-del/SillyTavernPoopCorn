import { describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import vm from 'node:vm';
import { TtsProviderRegistry } from '../public/scripts/extensions/tts/provider-registry.js';

const source = fs.readFileSync(new URL('../public/scripts/extensions/tts/index.js', import.meta.url), 'utf8');
const loadStart = source.indexOf('async function loadTtsProvider(provider)');
const loadEnd = source.indexOf('function onTtsProviderChange()', loadStart);
const registerStart = source.indexOf('export function registerTtsProvider(');
const registerEnd = source.indexOf('const ttsProviders =', registerStart);
const voiceMapStart = source.indexOf('export async function initVoiceMap(');
const voiceMapEnd = source.indexOf('export async function init()', voiceMapStart);
if ([loadStart, loadEnd, registerStart, registerEnd, voiceMapStart, voiceMapEnd].some(index => index < 0)) {
    throw new Error('Could not locate the TTS provider loading functions');
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function providerClass(name, loadSettings = jest.fn(async () => {})) {
    return class {
        settingsHtml = name;
        loadSettings = loadSettings;
    };
}

// Execute the production selection/registration functions without loading the
// full app. Deferred modules reproduce imports finishing out of selection order.
function createLoader(loaders, { realVoiceMap = false } = {}) {
    const registry = new TtsProviderRegistry(loaders);
    const settings = { tts: { enabled: realVoiceMap } };
    const ui = { settings: '', options: [], voices: [] };
    const initVoiceMap = jest.fn(async () => {});
    const setTtsStatus = jest.fn();
    const updateVoiceMap = jest.fn();
    class VoiceMapEntry {
        constructor(name, voiceId) { this.name = name; this.voiceId = voiceId; }
        addUI(voices) { ui.voices.push({ name: this.name, voiceId: this.voiceId, voices }); }
    }
    const $ = (selector) => {
        if (selector === '<option />') {
            return { val() { return this; }, text(name) { this.name = name; return this; } };
        }
        return {
            html(value) { ui.settings = value; },
            empty() { ui.voices = []; },
            is() { return settings.tts.enabled; },
            append(value) {
                if (selector === '#tts_provider') ui.options.push(value.name);
                else ui.settings += value;
            },
        };
    };
    const controller = vm.runInNewContext(`
        let ttsProvider, ttsProviderName;
        let providerLoadVersion = 0;
        let providerLoading = false;
        let currentInitVoiceMapPromise = null, currentInitVoiceMapVersion = null;
        let voiceMapEntries = [];
        ${source.slice(loadStart, loadEnd)}
        ${source.slice(registerStart, registerEnd).replace('export ', '')}
        ${realVoiceMap ? source.slice(voiceMapStart, voiceMapEnd).replace('export ', '') : ''}
        ({ loadTtsProvider, registerTtsProvider, runVoiceMap: initVoiceMap,
            state: () => ({ ttsProvider, ttsProviderName, providerLoading }) });
    `, { $, ttsProviders: registry, extension_settings: settings, initVoiceMap, setTtsStatus,
        resetTtsPlayback: jest.fn(), getCurrentChatId: () => 'chat', getCharacters: () => ['Alice'],
        VoiceMapEntry, updateVoiceMap, DEFAULT_VOICE_MARKER: 'default', DISABLED_VOICE_MARKER: 'disabled',
        toastr: { error: jest.fn() },
        console: { info: jest.fn(), error: jest.fn() } });
    return { ...controller, registry, settings, ui, initVoiceMap, setTtsStatus, updateVoiceMap };
}

describe('lazy TTS provider modules', () => {
    test('loads only the selected provider and coalesces repeated imports', async () => {
        const First = providerClass('first');
        const first = jest.fn(async () => First);
        const unused = jest.fn();
        const registry = new TtsProviderRegistry({ First: first, Unused: unused });
        expect([...registry.names()]).toEqual(['First', 'Unused']);
        expect(first).not.toHaveBeenCalled();
        const firstLoad = registry.load('First');
        expect(registry.load('First')).toBe(firstLoad);
        await expect(firstLoad).resolves.toBe(First);
        await expect(registry.load('First')).resolves.toBe(First);
        expect(first).toHaveBeenCalledTimes(1);
        expect(unused).not.toHaveBeenCalled();
    });

    test('keeps failed or invalid provider imports retryable', async () => {
        const Provider = providerClass('ready');
        const loader = jest.fn().mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(undefined).mockResolvedValueOnce(Provider);
        const registry = new TtsProviderRegistry({ Test: loader });
        await expect(registry.load('Test')).rejects.toThrow('offline');
        await expect(registry.load('Test')).rejects.toThrow('did not export a provider class');
        await expect(registry.load('Test')).resolves.toBe(Provider);
        await expect(registry.load('Unknown')).rejects.toThrow('Unknown TTS provider');
    });

    test('a slow import cannot replace a newer selection', async () => {
        const first = deferred();
        const loadFirstSettings = jest.fn(async () => {});
        const loader = createLoader({ First: () => first.promise, Second: async () => providerClass('second') });
        const staleLoad = loader.loadTtsProvider('First');
        await loader.loadTtsProvider('Second');
        first.resolve(providerClass('first', loadFirstSettings));
        await staleLoad;
        expect(loader.state().ttsProviderName).toBe('Second');
        expect(loader.state().providerLoading).toBe(false);
        expect(loader.ui.settings).toBe('second');
        expect(loadFirstSettings).not.toHaveBeenCalled();
        expect(loader.initVoiceMap).toHaveBeenCalledTimes(1);
    });

    test('a stale import failure cannot clear a newer provider', async () => {
        const first = deferred();
        const loader = createLoader({ First: () => first.promise, Second: async () => providerClass('second') });
        const staleLoad = loader.loadTtsProvider('First');
        await loader.loadTtsProvider('Second');
        first.reject(new Error('offline'));
        await staleLoad;
        expect(loader.state().ttsProvider.settingsHtml).toBe('second');
        expect(loader.setTtsStatus).not.toHaveBeenCalled();
    });

    test('clearing a selection cancels an outstanding import', async () => {
        const first = deferred();
        const loader = createLoader({ First: () => first.promise });
        const staleLoad = loader.loadTtsProvider('First');
        await loader.loadTtsProvider('');
        first.resolve(providerClass('first'));
        await staleLoad;
        expect(loader.state().ttsProvider).toBeUndefined();
        expect(loader.state().providerLoading).toBe(false);
        expect(loader.ui.settings).toBe('');
        expect(loader.initVoiceMap).not.toHaveBeenCalled();
    });

    test('reports load failure and can select the same provider again', async () => {
        const provider = jest.fn().mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(providerClass('ready'));
        const loader = createLoader({ Test: provider });
        await loader.loadTtsProvider('Test');
        expect(loader.state().ttsProvider).toBeUndefined();
        expect(loader.state().providerLoading).toBe(false);
        expect(loader.setTtsStatus).toHaveBeenCalledWith(expect.stringContaining('offline'), false);
        await loader.loadTtsProvider('Test');
        expect(loader.ui.settings).toBe('ready');
        expect(loader.initVoiceMap).toHaveBeenCalledTimes(1);
    });

    test('a previous settings load finishing does not initialize the new voice map twice', async () => {
        const settings = deferred();
        const entered = deferred();
        const loader = createLoader({ First: async () => providerClass('first', async () => {
            entered.resolve();
            await settings.promise;
        }), Second: async () => providerClass('second') });
        const staleLoad = loader.loadTtsProvider('First');
        await entered.promise;
        await loader.loadTtsProvider('Second');
        settings.resolve();
        await staleLoad;
        expect(loader.state().ttsProviderName).toBe('Second');
        expect(loader.initVoiceMap).toHaveBeenCalledTimes(1);
    });

    test('public registration supports custom providers and a saved custom selection', async () => {
        const loader = createLoader({ Builtin: async () => providerClass('builtin') });
        const Custom = providerClass('custom');
        loader.settings.tts.currentProvider = 'Custom';
        loader.registerTtsProvider('Custom', Custom);
        await new Promise(resolve => setImmediate(resolve));
        expect(loader.ui.options).toEqual(['Custom']);
        expect(loader.ui.settings).toBe('custom');
        expect(loader.state().ttsProvider).toBeInstanceOf(Custom);
        expect(() => loader.registerTtsProvider('Builtin', Custom)).toThrow('already registered');
        expect(() => loader.registerTtsProvider('Custom', Custom)).toThrow('already registered');
        expect(() => loader.registerTtsProvider('Bad', {})).toThrow('not a valid provider class');
    });

    test('old readiness completion during a new import cannot clear the selected provider', async () => {
        const ready = deferred();
        const entered = deferred();
        const secondImport = deferred();
        const staleFetch = jest.fn(async () => []);
        class First extends providerClass('first') {
            checkReady = async () => { entered.resolve(); await ready.promise; };
            fetchTtsVoiceObjects = staleFetch;
        }
        class Second extends providerClass('second') {
            checkReady = async () => {};
            fetchTtsVoiceObjects = async () => [{ name: 'Second Voice' }];
        }
        const loader = createLoader({ First: async () => First, Second: () => secondImport.promise }, { realVoiceMap: true });
        const oldLoad = loader.loadTtsProvider('First');
        await entered.promise;
        const newLoad = loader.loadTtsProvider('Second');
        ready.resolve();
        await oldLoad;
        expect(staleFetch).not.toHaveBeenCalled();
        secondImport.resolve(Second);
        await newLoad;
        expect(loader.state().ttsProvider).toBeInstanceOf(Second);
        expect(loader.ui.voices[0].voices).toEqual([{ name: 'Second Voice' }]);
        expect(loader.setTtsStatus).not.toHaveBeenCalledWith(expect.anything(), false);
    });

    test('new voice-map initialization does not wait for an old provider readiness request', async () => {
        const ready = deferred();
        const entered = deferred();
        class First extends providerClass('first') {
            checkReady = async () => { entered.resolve(); await ready.promise; };
            fetchTtsVoiceObjects = async () => [{ name: 'Old Voice' }];
        }
        class Second extends providerClass('second') {
            checkReady = async () => {};
            fetchTtsVoiceObjects = async () => [{ name: 'New Voice' }];
        }
        const loader = createLoader({ First: async () => First, Second: async () => Second }, { realVoiceMap: true });
        const oldLoad = loader.loadTtsProvider('First');
        await entered.promise;
        await loader.loadTtsProvider('Second');
        expect(loader.ui.voices[0].voices).toEqual([{ name: 'New Voice' }]);
        ready.resolve();
        await oldLoad;
        expect(loader.ui.voices[0].voices).toEqual([{ name: 'New Voice' }]);
        expect(loader.updateVoiceMap).toHaveBeenCalledTimes(1);
    });

    test('stale voice-list fetch cannot overwrite the newer provider voice map', async () => {
        const voices = deferred();
        const entered = deferred();
        class First extends providerClass('first') {
            checkReady = async () => {};
            fetchTtsVoiceObjects = async () => { entered.resolve(); return voices.promise; };
        }
        class Second extends providerClass('second') {
            checkReady = async () => {};
            fetchTtsVoiceObjects = async () => [{ name: 'New Voice' }];
        }
        const loader = createLoader({ First: async () => First, Second: async () => Second }, { realVoiceMap: true });
        const oldLoad = loader.loadTtsProvider('First');
        await entered.promise;
        await loader.loadTtsProvider('Second');
        voices.resolve([{ name: 'Old Voice' }]);
        await oldLoad;
        expect(loader.ui.voices[0].voices).toEqual([{ name: 'New Voice' }]);
        expect(loader.updateVoiceMap).toHaveBeenCalledTimes(1);
    });
});
