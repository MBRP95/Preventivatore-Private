#!/usr/bin/env python3
"""Sito del preventivatore.

Cliente: /cliente, senza password.
Shop assistant: password generale + PIN del negozio.
Amministratore: password separata, gestisce negozi e pubblica le offerte.

Avvio locale di prova, con negozio e amministratore:
  SITE_DEV=1 python3 site/server.py
Password di prova: negozio / PIN 1001 (Modena) e 1002 (Verona). Admin: admin.

Sito pubblico solo tablet, senza archivio clienti:
  SITE_TABLET=1 python3 site/server.py
Qui la pagina è il preventivatore del cliente. I consumi restano nel browser.
Non esistono login, negozio, amministratore né preventivi salvati.

In produzione del sito completo imposta SHOP_PASSWORD e ADMIN_PASSWORD.
I dati stanno in site/data/ e non vanno pubblicati.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
SITE = Path(__file__).resolve().parent
DATA = SITE / "data"
DB_PATH = DATA / "app.db"

STORE_FILE = ROOT / "PreventivatoreStore.html"
TABLET_FILE = ROOT / "PreventivatoreTablet.html"
EDITOR_FILE = ROOT / "modifica_listini.html"

DEV = os.environ.get("SITE_DEV") == "1"
TABLET_ONLY = os.environ.get("SITE_TABLET") == "1"
_TABLET_CACHE = {"mtime": None, "html": ""}
LOCK = threading.Lock()
FAILS: dict[str, list[float]] = {}


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def b64url(raw: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def b64url_decode(text: str) -> bytes:
    import base64
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def hash_secret(secret: str, salt: bytes | None = None) -> str:
    salt = salt or os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", secret.encode("utf-8"), salt, 120_000)
    return salt.hex() + ":" + digest.hex()


def verify_secret(secret: str, stored: str) -> bool:
    try:
        salt_hex, digest_hex = stored.split(":", 1)
        digest = hashlib.pbkdf2_hmac("sha256", secret.encode("utf-8"), bytes.fromhex(salt_hex), 120_000)
        return hmac.compare_digest(digest.hex(), digest_hex)
    except Exception:
        return False


def json_for_script(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")


def script_body(html: str, element_id: str) -> str | None:
    token = f'id="{element_id}"'
    start = html.find(token)
    if start < 0:
        return None
    open_end = html.find(">", start)
    close = html.find("</script>", open_end)
    if open_end < 0 or close < 0:
        return None
    return html[open_end + 1:close].strip()


def set_script_body(html: str, element_id: str, body: str) -> str:
    token = f'id="{element_id}"'
    start = html.find(token)
    if start < 0:
        block = f'<script type="application/json" id="{element_id}">{body}</script>\n'
        marker = html.find("<script>")
        if marker < 0:
            return html + block
        return html[:marker] + block + html[marker:]
    open_end = html.find(">", start)
    close = html.find("</script>", open_end)
    return html[:open_end + 1] + body + html[close:]


def inject_flag(html: str, flag: str) -> str:
    marker = html.find('const PROMO_CATALOG=JSON.parse')
    if marker < 0:
        marker = html.find('"use strict"; const $=id')
    script = html.rfind("<script>", 0, marker if marker > 0 else len(html))
    if script < 0:
        return html
    return html[:script] + f'<script>window.{flag}=true;</script>\n' + html[script:]


def db() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    return con


CON: sqlite3.Connection | None = None


def con() -> sqlite3.Connection:
    global CON
    if CON is None:
        DATA.mkdir(parents=True, exist_ok=True)
        CON = db()
        CON.executescript("""
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS shops (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          address TEXT NOT NULL DEFAULT '',
          email TEXT NOT NULL DEFAULT '',
          phone TEXT NOT NULL DEFAULT '',
          pin_hash TEXT NOT NULL DEFAULT '',
          active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS quotes (
          id TEXT PRIMARY KEY,
          number TEXT,
          shop_id TEXT NOT NULL,
          status TEXT NOT NULL,
          customer_name TEXT NOT NULL DEFAULT '',
          customer_email TEXT NOT NULL DEFAULT '',
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );
        """)
    return CON


def setting(key: str, default: str | None = None) -> str | None:
    row = con().execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def put_setting(key: str, value: str) -> None:
    con().execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))


def secret() -> bytes:
    current = setting("secret")
    if current:
        return bytes.fromhex(current)
    raw = os.urandom(32)
    put_setting("secret", raw.hex())
    con().commit()
    return raw


def sign_session(payload: dict) -> str:
    body = b64url(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(secret(), body.encode(), hashlib.sha256).hexdigest()
    return body + "." + sig


def read_session(token: str | None) -> dict | None:
    if not token or "." not in token:
        return None
    body, sig = token.rsplit(".", 1)
    expect = hmac.new(secret(), body.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expect, sig):
        return None
    try:
        data = json.loads(b64url_decode(body))
    except Exception:
        return None
    if int(data.get("exp") or 0) < time.time():
        return None
    return data


def issue(role: str, shop_id: str | None = None) -> str:
    return sign_session({"role": role, "shopId": shop_id or "", "exp": int(time.time()) + 12 * 3600})


def limited(ip: str) -> bool:
    now = time.time()
    recent = [t for t in FAILS.get(ip, []) if now - t < 600]
    FAILS[ip] = recent
    return len(recent) >= 8


def mark_fail(ip: str) -> None:
    FAILS.setdefault(ip, []).append(time.time())


def clear_fail(ip: str) -> None:
    FAILS.pop(ip, None)


def load_disk_json(path: Path, element_id: str):
    if not path.exists():
        return None
    body = script_body(path.read_text(encoding="utf-8"), element_id)
    if not body:
        return None
    return json.loads(body)


def seed() -> None:
    with LOCK:
        secret()
        if setting("shop_password") is None:
            shop_pw = os.environ.get("SHOP_PASSWORD") or ("negozio" if DEV else "")
            admin_pw = os.environ.get("ADMIN_PASSWORD") or ("admin" if DEV else "")
            if not shop_pw or not admin_pw:
                raise SystemExit("Imposta SHOP_PASSWORD e ADMIN_PASSWORD, oppure avvia con SITE_DEV=1.")
            put_setting("shop_password", hash_secret(shop_pw))
            put_setting("admin_password", hash_secret(admin_pw))
        if con().execute("SELECT COUNT(*) AS n FROM shops").fetchone()["n"] == 0:
            pins = {
                "modena": os.environ.get("MODENA_PIN") or ("1001" if DEV else ""),
                "verona": os.environ.get("VERONA_PIN") or ("1002" if DEV else ""),
            }
            rows = [
                ("modena", "Flagship Modena", "Via Emilia Centro, 84, Modena (MO)", "modena.emiliacentro@fastweb.it", "0599779958", pins["modena"]),
                ("verona", "Flagship Verona", "Via Cappello 33, Verona (VR)", "verona.cappello33@fastweb.it", "0459235440", pins["verona"]),
            ]
            for sid, name, address, email, phone, pin in rows:
                con().execute(
                    "INSERT INTO shops(id,name,address,email,phone,pin_hash) VALUES(?,?,?,?,?,?)",
                    (sid, name, address, email, phone, hash_secret(pin) if pin else ""),
                )
        if setting("catalog") is None:
            catalog = load_disk_json(STORE_FILE, "promo-catalog")
            if catalog is None:
                raise SystemExit("Manca il listino in PreventivatoreStore.html")
            put_setting("catalog", json.dumps(catalog, ensure_ascii=False))
            flyers = load_disk_json(TABLET_FILE, "flyer-pages") or []
            buttons = load_disk_json(TABLET_FILE, "flyer-buttons") or []
            put_setting("flyers", json.dumps(flyers, ensure_ascii=False))
            put_setting("buttons", json.dumps(buttons, ensure_ascii=False))
            put_setting("rev", "1")
        con().commit()


def catalog_obj() -> dict:
    return json.loads(setting("catalog") or "{}")


def flyers_obj():
    return json.loads(setting("flyers") or "[]")


def buttons_obj():
    return json.loads(setting("buttons") or "[]")


def shops_public() -> list[dict]:
    rows = con().execute("SELECT id,name,address,email,phone,pin_hash,active FROM shops ORDER BY name").fetchall()
    return [
        {"id": r["id"], "name": r["name"], "address": r["address"], "email": r["email"], "phone": r["phone"], "hasPin": bool(r["pin_hash"]), "active": bool(r["active"])}
        for r in rows
    ]


def shop_by_id(sid: str):
    return con().execute("SELECT * FROM shops WHERE id=? AND active=1", (sid,)).fetchone()


def shop_by_pin(pin: str):
    if not pin:
        return None
    for row in con().execute("SELECT * FROM shops WHERE active=1").fetchall():
        if row["pin_hash"] and verify_secret(pin, row["pin_hash"]):
            return row
    return None


def public_shop(row) -> dict:
    return {"id": row["id"], "name": row["name"], "address": row["address"], "email": row["email"], "phone": row["phone"]}


def customer_ready(payload: dict) -> bool:
    customer = payload.get("customer") or {}
    return all(str(customer.get(key) or "").strip() for key in ("name", "email", "phone"))


def quote_year(payload: dict) -> str:
    date = str((payload.get("customer") or {}).get("date") or "")
    if re.fullmatch(r"\d{4}", date[:4] or ""):
        return date[:4]
    return time.strftime("%Y")


def next_number(year: str) -> str:
    rows = con().execute("SELECT number FROM quotes WHERE number LIKE ?", (f"PREV-{year}-%",)).fetchall()
    nums = []
    for row in rows:
        part = str(row["number"] or "").split("-")[-1]
        if part.isdigit():
            nums.append(int(part))
    return f"PREV-{year}-{max(nums, default=0) + 1:03d}"


def stamp_shop(payload: dict, shop, consultant: str) -> dict:
    payload = dict(payload)
    payload["shopId"] = shop["id"]
    payload["shop"] = {
        "name": shop["name"],
        "address": shop["address"],
        "email": shop["email"],
        "phone": shop["phone"],
        "consultant": consultant,
    }
    return payload


def quote_out(row, session: dict) -> dict:
    payload = json.loads(row["payload"])
    own = session.get("role") == "admin" or row["shop_id"] == session.get("shopId")
    payload["_own"] = own
    payload["shopId"] = row["shop_id"]
    payload["quoteNumber"] = row["number"] or payload.get("quoteNumber")
    return payload


def can_write(session: dict, row) -> bool:
    return session.get("role") == "admin" or row["shop_id"] == session.get("shopId")


def save_quote(session: dict, payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("Preventivo non valido")
    qid = str(payload.get("id") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{4,80}", qid):
        raise ValueError("Identificativo del preventivo non valido")
    if not customer_ready(payload):
        raise ValueError("Per salvare servono nome, email e cellulare del cliente")
    consultant = str(((payload.get("shop") or {}).get("consultant")) or "").strip()
    existing = con().execute("SELECT * FROM quotes WHERE id=?", (qid,)).fetchone()
    if existing is None:
        if session.get("role") == "admin":
            shop = shop_by_id(str(payload.get("shopId") or ""))
            if shop is None:
                raise ValueError("Scegli il negozio del preventivo")
        else:
            shop = shop_by_id(session.get("shopId") or "")
            if shop is None:
                raise ValueError("Negozio non riconosciuto")
        payload = stamp_shop(payload, shop, consultant)
        number = next_number(quote_year(payload))
        payload["quoteNumber"] = number
        payload["savedAt"] = now_iso()
        payload.pop("_own", None)
        payload.pop("_filename", None)
        created = str(payload.get("createdAt") or now_iso())
        deleted = str(payload.get("deletedAt") or "")
        status = "trash" if deleted else "active"
        payload["status"] = "cestino" if deleted else "salvato"
        con().execute(
            "INSERT INTO quotes(id,number,shop_id,status,customer_name,customer_email,payload,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (qid, number, shop["id"], status, payload["customer"]["name"], payload["customer"]["email"], json.dumps(payload, ensure_ascii=False), created, now_iso(), deleted or None),
        )
    else:
        if not can_write(session, existing):
            raise PermissionError("Puoi modificare solo i preventivi del tuo negozio")
        shop = shop_by_id(existing["shop_id"])
        if shop is None:
            raise ValueError("Negozio del preventivo non trovato")
        old = json.loads(existing["payload"])
        payload = stamp_shop(payload, shop, consultant)
        payload["quoteNumber"] = existing["number"]
        payload["createdAt"] = old.get("createdAt") or existing["created_at"]
        payload["status"] = "active" if existing["status"] == "active" else existing["status"]
        if existing["status"] == "trash":
            payload["status"] = "cestino"
            payload["deletedAt"] = existing["deleted_at"]
        else:
            payload["status"] = "salvato"
            payload.pop("deletedAt", None)
        payload["savedAt"] = now_iso()
        payload.pop("_own", None)
        payload.pop("_filename", None)
        con().execute(
            "UPDATE quotes SET customer_name=?, customer_email=?, payload=?, updated_at=? WHERE id=?",
            (payload["customer"]["name"], payload["customer"]["email"], json.dumps(payload, ensure_ascii=False), now_iso(), qid),
        )
    con().commit()
    row = con().execute("SELECT * FROM quotes WHERE id=?", (qid,)).fetchone()
    return quote_out(row, session)


def set_status(session: dict, qid: str, status: str) -> None:
    row = con().execute("SELECT * FROM quotes WHERE id=?", (qid,)).fetchone()
    if row is None:
        raise ValueError("Preventivo non trovato")
    if not can_write(session, row):
        raise PermissionError("Puoi modificare solo i preventivi del tuo negozio")
    payload = json.loads(row["payload"])
    if status == "trash":
        payload["deletedAt"] = now_iso()
        payload["status"] = "cestino"
        con().execute("UPDATE quotes SET status='trash', deleted_at=?, payload=?, updated_at=? WHERE id=?", (payload["deletedAt"], json.dumps(payload, ensure_ascii=False), now_iso(), qid))
    else:
        payload.pop("deletedAt", None)
        payload["status"] = "salvato"
        con().execute("UPDATE quotes SET status='active', deleted_at=NULL, payload=?, updated_at=? WHERE id=?", (json.dumps(payload, ensure_ascii=False), now_iso(), qid))
    con().commit()


def customers_from_quotes() -> list[dict]:
    found = {}
    for row in con().execute("SELECT payload FROM quotes WHERE status='active' ORDER BY updated_at").fetchall():
        payload = json.loads(row["payload"])
        email = str((payload.get("customer") or {}).get("email") or "").strip().lower()
        if not email:
            continue
        customer = dict(payload.get("customer") or {})
        customer["shop"] = payload.get("shop") or {}
        found[email] = customer
    return list(found.values())


def validate_catalog(obj) -> dict:
    if not isinstance(obj, dict):
        raise ValueError("Listino non valido")
    for key in ("flat", "commodity", "indices"):
        if key not in obj:
            raise ValueError("Listino incompleto")
    return obj


def validate_flyers(obj) -> list:
    if not isinstance(obj, list) or len(obj) > 8:
        raise ValueError("Volantini non validi")
    clean = []
    for item in obj:
        if not isinstance(item, str) or not item.startswith("data:image/"):
            raise ValueError("Volantino non valido")
        if len(item) > 4_000_000:
            raise ValueError("Volantino troppo grande")
        clean.append(item)
    return clean


def validate_buttons(obj) -> list:
    if obj is None:
        return []
    if not isinstance(obj, list) or len(obj) > 8:
        raise ValueError("Posizione del pulsante non valida")
    return obj


def publish_from_html(store_html: str, tablet_html: str) -> None:
    catalog = validate_catalog(json.loads(script_body(store_html, "promo-catalog") or "null"))
    tablet_catalog = json.loads(script_body(tablet_html, "promo-catalog") or "null")
    validate_catalog(tablet_catalog)
    if json.dumps(catalog, sort_keys=True) != json.dumps(tablet_catalog, sort_keys=True):
        catalog = tablet_catalog
    flyers_raw = script_body(tablet_html, "flyer-pages")
    buttons_raw = script_body(tablet_html, "flyer-buttons")
    flyers = validate_flyers(json.loads(flyers_raw)) if flyers_raw else flyers_obj()
    buttons = validate_buttons(json.loads(buttons_raw)) if buttons_raw else buttons_obj()
    put_setting("catalog", json.dumps(catalog, ensure_ascii=False))
    put_setting("flyers", json.dumps(flyers, ensure_ascii=False))
    put_setting("buttons", json.dumps(buttons, ensure_ascii=False))
    put_setting("rev", str(int(setting("rev") or "1") + 1))
    con().commit()


PAGE_CACHE: dict[tuple, str] = {}


def rendered(kind: str) -> str:
    rev = setting("rev") or "1"
    path = {"store": STORE_FILE, "tablet": TABLET_FILE, "editor": EDITOR_FILE}[kind]
    key = (kind, rev, path.stat().st_mtime)
    cached = PAGE_CACHE.get(key)
    if cached is not None:
        return cached
    html = path.read_text(encoding="utf-8")
    if kind in ("store", "tablet"):
        html = set_script_body(html, "promo-catalog", json_for_script(catalog_obj()))
    if kind == "tablet":
        html = set_script_body(html, "flyer-pages", json_for_script(flyers_obj()))
        if buttons_obj():
            html = set_script_body(html, "flyer-buttons", json_for_script(buttons_obj()))
    if kind == "store":
        html = inject_flag(html, "__SITE")
    if kind == "editor":
        html = inject_flag(html, "__SITE")
    PAGE_CACHE.clear()
    PAGE_CACHE[key] = html
    return html


def slug_id(name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "negozio"
    sid = base
    n = 2
    while con().execute("SELECT 1 FROM shops WHERE id=?", (sid,)).fetchone():
        sid = f"{base}-{n}"
        n += 1
    return sid


class App(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        return

    def cookie_token(self) -> str | None:
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            part = part.strip()
            if part.startswith("session="):
                return part.split("=", 1)[1]
        return None

    def session(self) -> dict | None:
        return read_session(self.cookie_token())

    def send_json(self, code: int, payload: dict, cookie: str | None = None, clear: bool = False) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if cookie is not None:
            secure = "; Secure" if os.environ.get("SITE_HTTPS") == "1" else ""
            self.send_header("Set-Cookie", f"session={cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200{secure}")
        if clear:
            self.send_header("Set-Cookie", "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0")
        self.end_headers()
        self.wfile.write(body)

    def send_html(self, html: str, code: int = 200) -> None:
        body = html.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.end_headers()
        self.wfile.write(body)

    def redirect(self, location: str) -> None:
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def read_body(self, limit: int = 20_000_000):
        length = int(self.headers.get("Content-Length") or 0)
        if length < 0 or length > limit:
            self.send_json(413, {"error": "Richiesta troppo grande"})
            return None
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            self.send_json(400, {"error": "JSON non valido"})
            return None

    def require(self, roles: set[str]) -> dict | None:
        session = self.session()
        if not session or session.get("role") not in roles:
            self.send_json(401, {"error": "Accesso richiesto"})
            return None
        return session

    def do_GET(self) -> None:
        self.route("GET")

    def do_POST(self) -> None:
        self.route("POST")

    def do_DELETE(self) -> None:
        self.route("DELETE")

    def route(self, method: str) -> None:
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            with LOCK:
                self.dispatch(method, path, parse_qs(parsed.query))
        except PermissionError as exc:
            self.send_json(403, {"error": str(exc)})
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:
            import traceback
            traceback.print_exc()
            try:
                self.send_json(500, {"error": "Errore del server"})
            except Exception:
                pass

    def dispatch(self, method: str, path: str, query: dict) -> None:
        if TABLET_ONLY:
            if method == "GET" and path in ("/", "/cliente"):
                return self.send_html(tablet_file())
            return self.send_json(404, {"error": "Pagina non trovata"})
        if method == "GET" and path == "/":
            return self.send_html((SITE / "index.html").read_text(encoding="utf-8"))
        if method == "GET" and path == "/accesso":
            session = self.session()
            if session and session.get("role") == "admin":
                return self.redirect("/admin")
            if session and session.get("role") == "shop":
                return self.redirect("/negozio")
            return self.send_html((SITE / "accesso.html").read_text(encoding="utf-8"))
        if method == "GET" and path == "/cliente":
            return self.send_html(rendered("tablet"))
        if method == "GET" and path == "/negozio":
            session = self.session()
            if not session or session.get("role") not in ("shop", "admin"):
                return self.redirect("/accesso")
            return self.send_html(rendered("store"))
        if method == "GET" and path == "/admin":
            session = self.session()
            if not session or session.get("role") != "admin":
                return self.redirect("/accesso?admin=1")
            return self.send_html((SITE / "admin.html").read_text(encoding="utf-8"))
        if method == "GET" and path == "/listini":
            session = self.session()
            if not session or session.get("role") != "admin":
                return self.redirect("/accesso?admin=1")
            return self.send_html(rendered("editor"))
        if path == "/api/session" and method == "GET":
            session = self.session()
            if not session:
                return self.send_json(401, {"error": "Accesso richiesto"})
            if session.get("role") == "admin":
                return self.send_json(200, {"role": "admin", "shops": shops_public()})
            shop = shop_by_id(session.get("shopId") or "")
            if shop is None:
                return self.send_json(401, {"error": "Negozio non trovato"})
            return self.send_json(200, {"role": "shop", "shop": public_shop(shop)})
        if path == "/api/login" and method == "POST":
            return self.login_shop()
        if path == "/api/admin/login" and method == "POST":
            return self.login_admin()
        if path == "/api/logout" and method == "POST":
            return self.send_json(200, {"ok": True}, clear=True)
        if path == "/api/catalog" and method == "GET":
            return self.send_json(200, {"catalog": catalog_obj()})
        if path == "/api/quotes" and method == "GET":
            session = self.require({"shop", "admin"})
            if not session:
                return
            active = [quote_out(r, session) for r in con().execute("SELECT * FROM quotes WHERE status='active' ORDER BY created_at DESC").fetchall()]
            trash = [quote_out(r, session) for r in con().execute("SELECT * FROM quotes WHERE status='trash' ORDER BY deleted_at DESC").fetchall()]
            return self.send_json(200, {"quotes": active, "trash": trash, "customers": customers_from_quotes()})
        if path == "/api/quotes" and method == "POST":
            session = self.require({"shop", "admin"})
            if not session:
                return
            payload = self.read_body()
            if payload is None:
                return
            saved = save_quote(session, payload)
            return self.send_json(200, {"quote": saved})
        if path == "/api/import" and method == "POST":
            session = self.require({"shop", "admin"})
            if not session:
                return
            payload = self.read_body()
            if payload is None:
                return
            count = 0
            for source in list(payload.get("quotes") or []) + list(payload.get("trashQuotes") or []):
                if not isinstance(source, dict) or not source.get("id"):
                    continue
                if session.get("role") != "admin":
                    source["shopId"] = session.get("shopId")
                try:
                    save_quote(session, source)
                    count += 1
                except (ValueError, PermissionError):
                    continue
            return self.send_json(200, {"imported": count})
        match = re.fullmatch(r"/api/quotes/([A-Za-z0-9_-]+)/(trash|restore)", path)
        if match and method == "POST":
            session = self.require({"shop", "admin"})
            if not session:
                return
            set_status(session, match.group(1), "trash" if match.group(2) == "trash" else "active")
            return self.send_json(200, {"ok": True})
        match = re.fullmatch(r"/api/quotes/([A-Za-z0-9_-]+)", path)
        if match and method == "DELETE":
            session = self.require({"shop", "admin"})
            if not session:
                return
            row = con().execute("SELECT * FROM quotes WHERE id=?", (match.group(1),)).fetchone()
            if row is None:
                raise ValueError("Preventivo non trovato")
            if not can_write(session, row):
                raise PermissionError("Puoi eliminare solo i preventivi del tuo negozio")
            con().execute("DELETE FROM quotes WHERE id=?", (match.group(1),))
            con().commit()
            return self.send_json(200, {"ok": True})
        if path == "/api/shops" and method == "GET":
            session = self.require({"admin"})
            if not session:
                return
            return self.send_json(200, {"shops": shops_public()})
        if path == "/api/shops" and method == "POST":
            session = self.require({"admin"})
            if not session:
                return
            return self.save_shop()
        if path == "/api/admin/files" and method == "GET":
            session = self.require({"admin"})
            if not session:
                return
            return self.send_json(200, {"gestionale": rendered("store").replace("window.__SITE=true;", "window.__SITE_EDITOR_SOURCE=true;"), "cliente": rendered("tablet")})
        if path == "/api/admin/publish" and method == "POST":
            session = self.require({"admin"})
            if not session:
                return
            payload = self.read_body()
            if payload is None:
                return
            store_html = payload.get("gestionale") or ""
            tablet_html = payload.get("cliente") or ""
            if not store_html or not tablet_html:
                raise ValueError("Servono gestionale e preventivo cliente")
            publish_from_html(store_html, tablet_html)
            return self.send_json(200, {"ok": True})
        self.send_json(404, {"error": "Pagina non trovata"})

    def login_shop(self) -> None:
        ip = self.client_address[0]
        if limited(ip):
            return self.send_json(429, {"error": "Troppi tentativi. Riprova tra qualche minuto."})
        payload = self.read_body(20_000)
        if payload is None:
            return
        password = str(payload.get("password") or "")
        pin = str(payload.get("pin") or "")
        ok_password = verify_secret(password, setting("shop_password") or "")
        shop = shop_by_pin(pin)
        if not ok_password or shop is None:
            mark_fail(ip)
            return self.send_json(401, {"error": "Password o PIN non validi"})
        clear_fail(ip)
        return self.send_json(200, {"ok": True, "shop": public_shop(shop)}, cookie=issue("shop", shop["id"]))

    def login_admin(self) -> None:
        ip = self.client_address[0]
        if limited(ip):
            return self.send_json(429, {"error": "Troppi tentativi. Riprova tra qualche minuto."})
        payload = self.read_body(20_000)
        if payload is None:
            return
        password = str(payload.get("password") or "")
        if not verify_secret(password, setting("admin_password") or ""):
            mark_fail(ip)
            return self.send_json(401, {"error": "Password non valida"})
        clear_fail(ip)
        return self.send_json(200, {"ok": True}, cookie=issue("admin"))

    def save_shop(self) -> None:
        payload = self.read_body(100_000)
        if payload is None:
            return
        name = str(payload.get("name") or "").strip()
        if not name:
            raise ValueError("Scrivi il nome del negozio")
        sid = str(payload.get("id") or "").strip() or slug_id(name)
        pin = str(payload.get("pin") or "").strip()
        existing = con().execute("SELECT * FROM shops WHERE id=?", (sid,)).fetchone()
        if existing is None:
            if not pin:
                raise ValueError("Imposta un PIN per il negozio")
            con().execute(
                "INSERT INTO shops(id,name,address,email,phone,pin_hash,active) VALUES(?,?,?,?,?,?,1)",
                (sid, name, str(payload.get("address") or "").strip(), str(payload.get("email") or "").strip(), str(payload.get("phone") or "").strip(), hash_secret(pin)),
            )
        else:
            pin_hash = hash_secret(pin) if pin else existing["pin_hash"]
            con().execute(
                "UPDATE shops SET name=?, address=?, email=?, phone=?, pin_hash=? WHERE id=?",
                (name, str(payload.get("address") or "").strip(), str(payload.get("email") or "").strip(), str(payload.get("phone") or "").strip(), pin_hash, sid),
            )
        con().commit()
        return self.send_json(200, {"shops": shops_public()})


def tablet_file() -> str:
    mtime = TABLET_FILE.stat().st_mtime
    if _TABLET_CACHE["mtime"] != mtime:
        _TABLET_CACHE["mtime"] = mtime
        _TABLET_CACHE["html"] = TABLET_FILE.read_text(encoding="utf-8")
    return _TABLET_CACHE["html"]


def main() -> None:
    port = int(os.environ.get("PORT") or "8080")
    if TABLET_ONLY:
        print(f"Solo tablet su http://127.0.0.1:{port}. Nessun archivio clienti.")
    else:
        seed()
        print(f"Preventivatore su http://127.0.0.1:{port}")
        if DEV:
            print("Prova: password negozio, PIN Modena 1001, PIN Verona 1002, admin admin")
    try:
        server = ThreadingHTTPServer(("0.0.0.0", port), App)
    except OSError:
        print(f"La porta {port} è già in uso. Chiudi l'altra finestra del sito e riprova.")
        return
    if os.environ.get("SITE_OPEN") == "1":
        import webbrowser
        threading.Timer(0.7, lambda: webbrowser.open(f"http://127.0.0.1:{port}/")).start()
    print("Per spegnere il sito chiudi questa finestra.")
    server.serve_forever()


if __name__ == "__main__":
    main()
