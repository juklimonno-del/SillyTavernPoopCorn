/** Lazily resolves provider classes; failed imports remain retryable. */
export class TtsProviderRegistry {
    constructor(loaders) {
        this.loaders = new Map(Object.entries(loaders));
        this.pending = new Map();
    }

    has(name) {
        return this.loaders.has(name);
    }

    names() {
        return this.loaders.keys();
    }

    register(name, provider) {
        if (this.has(name)) throw new Error(`TTS provider ${name} is already registered.`);
        this.loaders.set(name, () => Promise.resolve(provider));
    }

    load(name) {
        if (!this.has(name)) return Promise.reject(new Error(`Unknown TTS provider: ${name}`));
        if (!this.pending.has(name)) {
            const pending = Promise.resolve().then(() => this.loaders.get(name)()).then(provider => {
                if (typeof provider !== 'function') throw new Error(`TTS provider ${name} did not export a provider class.`);
                return provider;
            }).catch(error => {
                this.pending.delete(name);
                throw error;
            });
            this.pending.set(name, pending);
        }
        return this.pending.get(name);
    }
}
