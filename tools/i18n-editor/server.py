#!/usr/bin/env python3
"""Local translation editor for the SwitchU i18n files.

Serves a small web UI for reviewing and editing romfs/i18n/*.json.
Standard library only - nothing to pip install.

    python tools/i18n-editor/server.py
    -> http://127.0.0.1:8765
"""

import argparse
import json
import os
import re
import sys
import tempfile
import webbrowser
from collections import OrderedDict
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
STATIC = os.path.join(HERE, "static")

# Each editable set of locale files. "reference" is the source of truth for
# both the key set and the canonical key order.
PROJECTS = OrderedDict([
    ("menu", {
        "label": "SwitchU (menu)",
        "dir": os.path.join(REPO, "romfs", "i18n"),
        "reference": "en-US",
    }),
    ("manager", {
        "label": "SwitchU Manager",
        "dir": os.path.join(REPO, "projects", "manager", "romfs", "i18n"),
        "reference": "en-US",
    }),
])

LOCALE_RE = re.compile(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,4})?$")
# {}, {0}, {name}, %s, %d, \n - these must survive translation untouched
PLACEHOLDER_RE = re.compile(r"\{[^}\s]*\}|%[sdfi]|\\n")


# ---------------------------------------------------------------------------
# json helpers
# ---------------------------------------------------------------------------

def load(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f, object_pairs_hook=OrderedDict)


def flatten(node, prefix=""):
    out = OrderedDict()
    for k, v in node.items():
        key = prefix + "." + k if prefix else k
        if isinstance(v, dict):
            out.update(flatten(v, key))
        else:
            out[key] = v
    return out


def detect_newline(path):
    """Keep each file's existing line ending so saves stay diff-clean."""
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError:
        return "\n"
    return "\r\n" if b"\r\n" in raw else "\n"


def build_tree(ref, cur, values, reorder, prefix=""):
    """Rebuild the target tree.

    reorder=True  -> follow the reference key order (the repo convention,
                     already used by es-ES / es-419 / fr-FR).
    reorder=False -> keep the target file's own order, appending any keys it
                     was missing in reference order.

    Keys present in the target but absent from the reference are preserved.
    """
    ref = ref if isinstance(ref, dict) else OrderedDict()
    cur = cur if isinstance(cur, dict) else OrderedDict()

    if reorder:
        order = list(ref) + [k for k in cur if k not in ref]
    else:
        order = list(cur) + [k for k in ref if k not in cur]

    out = OrderedDict()
    for k in order:
        key = prefix + "." + k if prefix else k
        rv = ref.get(k)
        cv = cur.get(k)
        if isinstance(rv, dict) or isinstance(cv, dict):
            child = build_tree(rv, cv, values, reorder, key)
            if child:
                out[k] = child
        elif key in values:
            # None means "submitted blank" -> drop the key so the runtime
            # falls back to the reference locale instead of showing ""
            if values[key] is not None:
                out[k] = values[key]
        elif cv is not None:
            out[k] = cv
    return out


def write_json(path, tree, newline):
    text = json.dumps(tree, ensure_ascii=False, indent=2) + "\n"
    if newline != "\n":
        text = text.replace("\n", newline)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".i18n-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(text.encode("utf-8"))
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


# ---------------------------------------------------------------------------
# analysis
# ---------------------------------------------------------------------------

def locale_path(project, locale):
    if project not in PROJECTS:
        raise ValueError("unknown project: " + str(project))
    if not LOCALE_RE.match(locale or ""):
        raise ValueError("bad locale tag: " + str(locale))
    root = os.path.abspath(PROJECTS[project]["dir"])
    path = os.path.abspath(os.path.join(root, locale + ".json"))
    if os.path.dirname(path) != root:
        raise ValueError("path escapes the locale directory")
    return path


def list_locales(project):
    root = PROJECTS[project]["dir"]
    ref = PROJECTS[project]["reference"]
    try:
        names = sorted(n[:-5] for n in os.listdir(root) if n.endswith(".json"))
    except OSError:
        return []
    try:
        ref_flat = flatten(load(os.path.join(root, ref + ".json")))
    except (OSError, ValueError):
        ref_flat = OrderedDict()

    total = len(ref_flat) or 1
    out = []
    for name in names:
        try:
            cur = flatten(load(os.path.join(root, name + ".json")))
        except (OSError, ValueError):
            continue
        present = sum(1 for k in ref_flat if k in cur)
        same = sum(1 for k in ref_flat if k in cur and cur[k] == ref_flat[k])
        out.append({
            "locale": name,
            "isReference": name == ref,
            "total": len(ref_flat),
            "present": present,
            "missing": len(ref_flat) - present,
            "sameAsRef": same,
            "coverage": round(100.0 * present / total, 1),
        })
    return out


def analyse(project, locale):
    conf = PROJECTS[project]
    ref_flat = flatten(load(locale_path(project, conf["reference"])))

    path = locale_path(project, locale)
    cur_flat = flatten(load(path)) if os.path.exists(path) else OrderedDict()

    rows = []
    for key, ref_val in ref_flat.items():
        val = cur_flat.get(key)
        issues = []
        if val is None:
            status = "missing"
        elif val == ref_val:
            status = "untranslated"
        else:
            status = "done"
        if val is not None:
            if sorted(PLACEHOLDER_RE.findall(ref_val)) != sorted(PLACEHOLDER_RE.findall(val)):
                issues.append("placeholder")
            if ref_val.endswith(" ") != val.endswith(" "):
                issues.append("trailing-space")
            if len(ref_val) >= 4 and len(val) > max(24, len(ref_val) * 1.8):
                issues.append("long")
        rows.append({
            "key": key,
            "ref": ref_val,
            "value": val,
            "status": status,
            "issues": issues,
            "placeholders": sorted(set(PLACEHOLDER_RE.findall(ref_val))),
        })

    for key in [k for k in cur_flat if k not in ref_flat]:
        rows.append({
            "key": key, "ref": None, "value": cur_flat[key],
            "status": "extra", "issues": ["extra"], "placeholders": [],
        })

    return {
        "project": project,
        "locale": locale,
        "reference": conf["reference"],
        "exists": os.path.exists(path),
        "path": os.path.relpath(path, REPO).replace("\\", "/"),
        "newline": "CRLF" if detect_newline(path) == "\r\n" else "LF",
        "rows": rows,
    }


def save(project, locale, values, reorder):
    if project not in PROJECTS:
        raise ValueError("unknown project: " + str(project))
    conf = PROJECTS[project]
    if locale == conf["reference"]:
        raise ValueError("refusing to edit the reference locale (" + locale + ")")

    ref = load(locale_path(project, conf["reference"]))
    path = locale_path(project, locale)
    cur = load(path) if os.path.exists(path) else OrderedDict()
    newline = detect_newline(path) if os.path.exists(path) else "\n"

    # A key submitted blank is an explicit delete; a key not submitted at all
    # keeps whatever is already on disk.
    clean = {}
    for k, v in (values or {}).items():
        if isinstance(v, str):
            clean[k] = None if v.strip() == "" else v

    tree = build_tree(ref, cur, clean, reorder)
    write_json(path, tree, newline)
    return {
        "ok": True,
        "path": os.path.relpath(path, REPO).replace("\\", "/"),
        "keys": len(flatten(tree)),
    }


# ---------------------------------------------------------------------------
# http
# ---------------------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC, **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("  " + (fmt % args) + "\n")

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path == "/api/projects":
                return self._json({
                    "repo": REPO,
                    "projects": [
                        {"id": pid, "label": p["label"],
                         "reference": p["reference"], "locales": list_locales(pid)}
                        for pid, p in PROJECTS.items()
                    ],
                })
            if u.path == "/api/locale":
                return self._json(analyse(q.get("project", ["menu"])[0],
                                          q.get("locale", [""])[0]))
        except ValueError as e:
            return self._json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001 - surface it in the UI
            return self._json({"error": type(e).__name__ + ": " + str(e)}, 500)
        return super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        try:
            n = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
            if u.path == "/api/save":
                return self._json(save(payload.get("project", ""),
                                       payload.get("locale", ""),
                                       payload.get("values") or {},
                                       bool(payload.get("reorder", True))))
        except ValueError as e:
            return self._json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            return self._json({"error": type(e).__name__ + ": " + str(e)}, 500)
        self.send_error(404)


def main():
    ap = argparse.ArgumentParser(description="SwitchU i18n editor")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    for pid, p in PROJECTS.items():
        state = "ok" if os.path.isdir(p["dir"]) else "MISSING"
        print("  %-8s %-34s [%s]" % (pid, os.path.relpath(p["dir"], REPO), state))

    url = "http://%s:%d" % (args.host, args.port)
    print("\n  SwitchU i18n editor -> %s   (Ctrl+C to stop)\n" % url)
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
