/**
 * @file Spellcheck Web Worker.
 *
 * Loads a Hunspell-format en_US dictionary on first use and answers
 * "check / suggest / addWord" requests from the main thread via nspell.
 *
 * Messages in:
 *   { type: 'init', customWords: string[] }
 *   { type: 'check', id: number, words: string[] }
 *   { type: 'suggest', id: number, word: string }
 *   { type: 'addWord', word: string }
 *
 * Messages out:
 *   { type: 'check', id: number, misspelled: string[] }
 *   { type: 'suggest', id: number, suggestions: string[] }
 *   { type: 'ready' }
 */

import nspell from "nspell";

type CheckMsg = { type: "check"; id: number; words: string[] };
type SuggestMsg = { type: "suggest"; id: number; word: string };
type AddWordMsg = { type: "addWord"; word: string };
type InitMsg = { type: "init"; customWords: string[] };
type InMsg = CheckMsg | SuggestMsg | AddWordMsg | InitMsg;

let checker: ReturnType<typeof nspell> | null = null;
let loadingPromise: Promise<ReturnType<typeof nspell>> | null = null;
const pendingCustom: string[] = [];

async function getChecker(): Promise<ReturnType<typeof nspell>> {
    if (checker) return checker;
    if (loadingPromise) return loadingPromise;

    loadingPromise = (async () => {
        const [aff, dic] = await Promise.all([
            fetch("/dictionaries/en_US/en_US.aff").then((r) => {
                if (!r.ok) throw new Error("aff fetch " + r.status);
                return r.text();
            }),
            fetch("/dictionaries/en_US/en_US.dic").then((r) => {
                if (!r.ok) throw new Error("dic fetch " + r.status);
                return r.text();
            }),
        ]);
        const c = nspell(aff, dic);
        while (pendingCustom.length) {
            const w = pendingCustom.shift()!;
            c.add(w);
        }
        checker = c;
        (self as unknown as Worker).postMessage({ type: "ready" });
        return c;
    })();

    return loadingPromise;
}

self.addEventListener("message", async (event: MessageEvent<InMsg>) => {
    const msg = event.data;
    switch (msg.type) {
        case "init": {
            if (checker) {
                for (const w of msg.customWords) checker.add(w);
            } else {
                pendingCustom.push(...msg.customWords);
            }
            void getChecker();
            return;
        }
        case "addWord": {
            if (checker) checker.add(msg.word);
            else pendingCustom.push(msg.word);
            return;
        }
        case "check": {
            const c = await getChecker();
            const misspelled: string[] = [];
            for (const w of msg.words) {
                if (!c.correct(w)) misspelled.push(w);
            }
            (self as unknown as Worker).postMessage({
                type: "check",
                id: msg.id,
                misspelled,
            });
            return;
        }
        case "suggest": {
            const c = await getChecker();
            (self as unknown as Worker).postMessage({
                type: "suggest",
                id: msg.id,
                suggestions: c.suggest(msg.word),
            });
            return;
        }
    }
});
