/**
 * @file CodeMirror 6 extension that underlines misspelled words.
 *
 * Walks the visible viewport, uses the markdown Lezer tree to skip code,
 * URLs, links, frontmatter, etc., subtracts wikilink ranges with a regex,
 * tokenizes the remaining prose into words, and asks the worker which are
 * misspelled. Misspellings become Decoration.mark ranges with class
 * 'cm-misspelled'.
 */

import {
    Decoration,
    type DecorationSet,
    EditorView,
    ViewPlugin,
    type ViewUpdate,
} from "@codemirror/view";
import { StateField, StateEffect, RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { getSpellChecker } from "./index";

/** Lezer markdown node names whose contents should NOT be spell-checked. */
const SKIP_NODE_TYPES = new Set([
    "FencedCode",
    "CodeBlock",
    "InlineCode",
    "CodeText",
    "URL",
    "Link",
    "Image",
    "HTMLTag",
    "HTMLBlock",
    "ProcessingInstruction",
    "CommentBlock",
    "FrontMatterMark",
    "Frontmatter",
    "FrontMatter",
    "YAMLcontent",
    "yamlFrontmatter",
]);

const WORD_RE = /\p{L}[\p{L}\p{M}'\u2019]*/gu;
const WIKILINK_RE = /\[\[[^\]]+\]\]/g;

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
 * offsets) that exclude code/links/URLs/frontmatter. Wikilinks are subtracted
 * via a regex pass since the markdown parser doesn't model them as nodes.
 */
function collectProseRanges(view: EditorView): SpellcheckRange[] {
    const ranges: SpellcheckRange[] = [];
    const tree = syntaxTree(view.state);
    const doc = view.state.doc;

    for (const { from, to } of view.visibleRanges) {
        // Start with the whole visible range as prose, then carve out skip
        // nodes.
        const skips: SpellcheckRange[] = [];
        tree.iterate({
            from,
            to,
            enter: (node) => {
                if (SKIP_NODE_TYPES.has(node.name)) {
                    skips.push({ from: node.from, to: node.to });
                    return false;
                }
            },
        });

        // Subtract wikilinks via regex.
        const text = doc.sliceString(from, to);
        WIKILINK_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = WIKILINK_RE.exec(text))) {
            skips.push({
                from: from + m.index,
                to: from + m.index + m[0].length,
            });
        }

        // Merge skip ranges and emit the gaps.
        skips.sort((a, b) => a.from - b.from);
        const merged: SpellcheckRange[] = [];
        for (const s of skips) {
            const last = merged[merged.length - 1];
            if (last && s.from <= last.to) {
                last.to = Math.max(last.to, s.to);
            } else {
                merged.push({ ...s });
            }
        }

        let cursor = from;
        for (const s of merged) {
            if (s.from > cursor) {
                ranges.push({ from: cursor, to: Math.min(s.from, to) });
            }
            cursor = Math.max(cursor, s.to);
            if (cursor >= to) break;
        }
        if (cursor < to) ranges.push({ from: cursor, to });
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
