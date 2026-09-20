# SwitchU i18n editor

A small local web UI for reviewing and editing the translation files in
`romfs/i18n/` and `projects/manager/romfs/i18n/`.

Python standard library only — nothing to install.

```bash
python tools/i18n-editor/server.py
# -> http://127.0.0.1:8765  (opens automatically)
```

Options: `--port 8765`, `--host 127.0.0.1`, `--no-browser`.

## What it does

`en-US.json` is the reference: it defines the key set, the key order and the
English text every row is compared against. It is read-only in the UI — the
server refuses to write to it.

Each row shows the key, the English string and an editable box for the target
language, plus live warnings:

| Aviso           | Meaning                                                             |
| --------------- | ------------------------------------------------------------------- |
| `falta`         | the key is absent from this locale (the console falls back to en-US) |
| `sin traducir`  | the value is byte-identical to the English one                       |
| `placeholder`   | `{}`, `{0}`, `{name}`, `%s`, `\n` differ from the English string      |
| `espacio final` | a trailing space was added or lost (some strings are concatenated)    |
| `largo`         | much longer than English — likely to overflow a fixed-size UI row     |
| `sobra`         | the key exists here but not in `en-US.json`                           |

Filters: *Pendientes* (anything needing attention), *Faltantes*, *Sin traducir*,
*Avisos*, *Hechas*. `/` focuses the search box, `Ctrl+S` saves.

## Saving

Writes are atomic (temp file + replace) and preserve each file's existing
conventions: 2-space indent, real accented characters (never `\uXXXX`), a
trailing newline, and the file's own line endings — most locales here are CRLF,
while `es-ES` / `es-419` are LF.

- **`orden de en-US`** (on by default) writes keys in the reference order, which
  is the convention `es-ES`, `es-419` and `fr-FR` already follow. Turn it off to
  keep a file's existing order — useful for `de-DE`, `it-IT`, `nl-NL`, `pt-BR`
  and `ru-RU`, which have their own ordering, so the diff stays small.
- **Clearing a box deletes the key** rather than writing `""`, so the runtime
  falls back to English instead of rendering an empty string.
- Keys present in a locale but missing from `en-US.json` are never dropped.

Saving a locale without editing anything rewrites it byte-for-byte identically,
so an accidental save can't produce diff noise. Everything is under git anyway —
use `git diff romfs/i18n/` to review before committing.
