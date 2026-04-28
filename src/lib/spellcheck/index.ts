/**
 * @file Singleton client wrapper around the spellcheck Web Worker.
 *
 * Lazily instantiates the worker on first access (and only in the browser).
 * Exposes a small Promise-based API: check(words), suggest(word), addWord(word),
 * init(customWords), and dispose().
 */

import { browser } from "$app/environment";
import SpellWorker from "./worker.ts?worker";

type CheckResponse = { type: "check"; id: number; misspelled: string[] };
type SuggestResponse = {
    type: "suggest";
    id: number;
    suggestions: string[];
};
type ReadyResponse = { type: "ready" };
type WorkerResponse = CheckResponse | SuggestResponse | ReadyResponse;

interface PendingCheck {
    resolve: (misspelled: string[]) => void;
}
interface PendingSuggest {
    resolve: (suggestions: string[]) => void;
}

class SpellCheckerClient {
    private worker: Worker | null = null;
    private nextId = 1;
    private checks = new Map<number, PendingCheck>();
    private suggests = new Map<number, PendingSuggest>();

    private ensureWorker(): Worker | null {
        if (!browser) return null;
        if (this.worker) return this.worker;

        const w = new SpellWorker();
        w.addEventListener("message", (e: MessageEvent<WorkerResponse>) => {
            const msg = e.data;
            if (msg.type === "check") {
                this.checks.get(msg.id)?.resolve(msg.misspelled);
                this.checks.delete(msg.id);
            } else if (msg.type === "suggest") {
                this.suggests.get(msg.id)?.resolve(msg.suggestions);
                this.suggests.delete(msg.id);
            }
            // 'ready' is currently informational only.
        });
        this.worker = w;
        return w;
    }

    /** Send the initial custom-word list at editor mount. */
    init(customWords: string[]): void {
        const w = this.ensureWorker();
        if (!w) return;
        w.postMessage({ type: "init", customWords });
    }

    check(words: string[]): Promise<string[]> {
        const w = this.ensureWorker();
        if (!w || words.length === 0) return Promise.resolve([]);
        const id = this.nextId++;
        return new Promise<string[]>((resolve) => {
            this.checks.set(id, { resolve });
            w.postMessage({ type: "check", id, words });
        });
    }

    suggest(word: string): Promise<string[]> {
        const w = this.ensureWorker();
        if (!w) return Promise.resolve([]);
        const id = this.nextId++;
        return new Promise<string[]>((resolve) => {
            this.suggests.set(id, { resolve });
            w.postMessage({ type: "suggest", id, word });
        });
    }

    addWord(word: string): void {
        const w = this.ensureWorker();
        if (!w) return;
        w.postMessage({ type: "addWord", word });
    }

    dispose(): void {
        this.worker?.terminate();
        this.worker = null;
        this.checks.clear();
        this.suggests.clear();
    }
}

let singleton: SpellCheckerClient | null = null;

export function getSpellChecker(): SpellCheckerClient {
    if (!singleton) singleton = new SpellCheckerClient();
    return singleton;
}
