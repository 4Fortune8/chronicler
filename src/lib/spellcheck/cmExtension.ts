/**
 * @file CodeMirror 6 extension that underlines misspelled words.
 *
 * Only checks text inside double- or single-quoted string values, or inside
 * the body of <p>, <div>, and <h1>-<h6> HTML elements. Wikilinks are still
 * subtracted from those ranges. Misspellings become Decoration.mark ranges
 * with class 'cm-misspelled'.
 */

import {
    Decoration,
    type DecorationSet,
    EditorView,
    ViewPlugin,
    type ViewUpdate,
} from "@codemirror/view";
import { StateField, StateEffect, RangeSetBuilder } from "@codemirror/state";
import { getSpellChecker } from "./index";

const WORD_RE = /\p{L}[\p{L}\p{M}'\u2019]*/gu;
const WIKILINK_RE = /\[\[[^\]]+\]\]/g;

// Quoted string values: "..." or '...'. Non-greedy; no embedded newlines so
// stray quotes don't run away across the document. Backslash escapes are
// honored so escaped quotes don't terminate the value.
const QUOTED_RE = /"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)'/g;

// Body of <p>, <div>, or <h1>-<h6>. Multiline, case-insensitive. Captures the
// inner text only (group 2) so the tags themselves aren't checked.
const HTML_BLOCK_RE =
    /<(p|div|h[1-6])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;

const setMisspellings = StateEffect.define<{
    ranges: { from: number; to: number }[];
}>();

export interface SpellcheckRange {
    from: number;
    to: number;
}

/** State field holding the current decoration set of misspelled ranges. */
const misspelledField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
        deco = deco.map(tr.changes);
        for (const e of tr.effects) {
            if (e.is(setMisspellings)) {
                const builder = new RangeSetBuilder<Decoration>();
                const sorted = [...e.value.ranges].sort(
                    (a, b) => a.from - b.from || a.to - b.to,
                );
                for (const r of sorted) {
                    builder.add(
                        r.from,
                        r.to,
                        Decoration.mark({ class: "cm-misspelled" }),
                    );
                }
                deco = builder.finish();
            }
        }
        return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
});

/**
 * Walk the visible viewport, returning prose ranges (start/end document
 * offsets) that lie inside quoted string values or inside the body of
 * <p>/<div>/<h1>-<h6> HTML elements. Wikilinks are subtracted via a regex
 * pass.
 */
function collectProseRanges(view: EditorView): SpellcheckRange[] {
    const ranges: SpellcheckRange[] = [];
    const doc = view.state.doc;

    for (const { from, to } of view.visibleRanges) {
        const text = doc.sliceString(from, to);

        const includes: SpellcheckRange[] = [];

        // Quoted-string values.
        QUOTED_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = QUOTED_RE.exec(text))) {
            // Inner content sits between the surrounding quote marks.
            const innerFrom = from + m.index + 1;
            const innerTo = from + m.index + m[0].length - 1;
            if (innerTo > innerFrom) {
                includes.push({ from: innerFrom, to: innerTo });
            }
        }

        // <p>, <div>, <h1>-<h6> bodies.
        HTML_BLOCK_RE.lastIndex = 0;
        while ((m = HTML_BLOCK_RE.exec(text))) {
            const openLen = m[0].indexOf(m[2]);
            const innerFrom = from + m.index + openLen;
            const innerTo = innerFrom + m[2].length;
            if (innerTo > innerFrom) {
                includes.push({ from: innerFrom, to: innerTo });
            }
        }

        if (includes.length === 0) continue;

        // Subtract wikilinks.
        const skips: SpellcheckRange[] = [];
        WIKILINK_RE.lastIndex = 0;
        while ((m = WIKILINK_RE.exec(text))) {
            skips.push({
                from: from + m.index,
                to: from + m.index + m[0].length,
            });
        }

        // Merge & sort includes.
        includes.sort((a, b) => a.from - b.from);
        const mergedIncl: SpellcheckRange[] = [];
        for (const r of includes) {
            const last = mergedIncl[mergedIncl.length - 1];
            if (last && r.from <= last.to) {
                last.to = Math.max(last.to, r.to);
            } else {
                mergedIncl.push({ ...r });
            }
        }

        // Subtract skip ranges from each include.
        skips.sort((a, b) => a.from - b.from);
        for (const incl of mergedIncl) {
            let cursor = incl.from;
            for (const s of skips) {
                if (s.to <= cursor) continue;
                if (s.from >= incl.to) break;
                if (s.from > cursor) {
                    ranges.push({
                        from: cursor,
                        to: Math.min(s.from, incl.to),
                    });
                }
                cursor = Math.max(cursor, s.to);
                if (cursor >= incl.to) break;
            }
            if (cursor < incl.to) ranges.push({ from: cursor, to: incl.to });
        }
    }
    return ranges;
}

interface WordToken {
    word: string;
    from: number;
    to: number;
}

function tokenizeRanges(view: EditorView, ranges: SpellcheckRange[]): WordToken[] {
    const tokens: WordToken[] = [];
    const doc = view.state.doc;
    for (const r of ranges) {
        if (r.to <= r.from) continue;
        const text = doc.sliceString(r.from, r.to);
        WORD_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = WORD_RE.exec(text))) {
            const word = m[0];
            // Skip very short words and pure-numbers (regex already excludes
            // pure numbers via \p{L} requirement, but skip ALL CAPS short
            // tokens that are likely acronyms).
            if (word.length < 2) continue;
            if (word.length <= 4 && word === word.toUpperCase()) continue;
            tokens.push({
                word,
                from: r.from + m.index,
                to: r.from + m.index + word.length,
            });
        }
    }
    return tokens;
}

/**
 * Build the spellcheck extension.
 *
 * @param getEnabled    () => boolean — whether spellcheck is currently on
 * @param getCustomWords () => string[] — set of user-added "good" words
 *                       (used as a runtime allowlist on top of nspell).
 */
export function spellcheckExtension(
    getEnabled: () => boolean,
    getCustomWords: () => string[],
) {
    const plugin = ViewPlugin.fromClass(
        class {
            timer: ReturnType<typeof setTimeout> | null = null;
            generation = 0;
            // Words the user chose to "Ignore once" for the lifetime of this view.
            ignored = new Set<string>();

            constructor(public view: EditorView) {
                this.schedule();
            }

            update(u: ViewUpdate) {
                if (u.docChanged || u.viewportChanged) this.schedule();
            }

            destroy() {
                if (this.timer) clearTimeout(this.timer);
            }

            schedule() {
                if (!getEnabled()) {
                    if (this.timer) clearTimeout(this.timer);
                    // Clear any existing decorations.
                    this.view.dispatch({
                        effects: setMisspellings.of({ ranges: [] }),
                    });
                    return;
                }
                if (this.timer) clearTimeout(this.timer);
                const gen = ++this.generation;
                this.timer = setTimeout(() => this.run(gen), 350);
            }

            async run(gen: number) {
                if (gen !== this.generation) return;
                if (!getEnabled()) return;

                const ranges = collectProseRanges(this.view);
                const tokens = tokenizeRanges(this.view, ranges);

                const custom = new Set(
                    getCustomWords().map((w) => w.toLowerCase()),
                );
                const ignored = this.ignored;

                // Deduplicate words sent to the worker; track all positions per word.
                const positions = new Map<string, WordToken[]>();
                for (const tok of tokens) {
                    const key = tok.word;
                    if (custom.has(key.toLowerCase())) continue;
                    if (ignored.has(key)) continue;
                    let arr = positions.get(key);
                    if (!arr) {
                        arr = [];
                        positions.set(key, arr);
                    }
                    arr.push(tok);
                }
                const uniqueWords = [...positions.keys()];
                if (uniqueWords.length === 0) {
                    this.view.dispatch({
                        effects: setMisspellings.of({ ranges: [] }),
                    });
                    return;
                }

                const misspelled = await getSpellChecker().check(uniqueWords);
                if (gen !== this.generation) return; // a newer run superseded us

                const out: SpellcheckRange[] = [];
                for (const w of misspelled) {
                    const arr = positions.get(w);
                    if (!arr) continue;
                    for (const tok of arr) {
                        out.push({ from: tok.from, to: tok.to });
                    }
                }
                this.view.dispatch({
                    effects: setMisspellings.of({ ranges: out }),
                });
            }

            ignoreOnce(word: string) {
                this.ignored.add(word);
                this.schedule();
            }
        },
    );

    return [misspelledField, plugin];
}

/**
 * Given a click position, find the misspelled-decoration range under the
 * cursor (if any). Returns the document range and the word string.
 */
export function findMisspelledAt(
    view: EditorView,
    pos: number,
): { from: number; to: number; word: string } | null {
    const decos = view.state.field(misspelledField, false);
    if (!decos) return null;
    let hit: { from: number; to: number } | null = null;
    decos.between(pos, pos, (from, to) => {
        if (from <= pos && pos <= to) {
            hit = { from, to };
            return false;
        }
    });
    if (!hit) return null;
    const h = hit as { from: number; to: number };
    return {
        from: h.from,
        to: h.to,
        word: view.state.doc.sliceString(h.from, h.to),
    };
}
