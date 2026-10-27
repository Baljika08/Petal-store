// PETAL store: захиалга ба барааны сан (Cloudflare D1).
// Сайтын файлуудыг (index.html) Cloudflare шууд өгнө; энэ код зөвхөн /api/... болон /img/... хаягийг хариуцна.
//
// Худалдан авагч (нууц үг хэрэггүй):
//   POST /api/orders              захиалга үүсгэх / засах (төлбөрийн алхам руу орохдоо)  → { id, code, tok }
//   POST /api/orders/<id>/sent    «Шилжүүлсэн» гэж мэдэгдэх
//   GET  /api/catalog             нэмсэн / зассан / устгасан бараа
//   GET  /img/<id>                барааны зураг
// Эзэн (ADMIN_KEY нууц үгтэй):
//   GET    /api/orders            захиалгын жагсаалт
//   POST   /api/orders/manual     хуучин урт кодоор гүйлгээнээс нэмэх
//   PATCH  /api/orders/<id>       төлсөн / төлөөгүй
//   DELETE /api/orders/<id>       устгах
//   POST   /api/img               зураг хадгалах
//   POST   /api/products          шинэ бараа
//   PUT    /api/products/<id>     бараа засах / устгах (del:1) / сэргээх (del:0)
// ADMIN_KEY-ийг Cloudflare дээр Settings → Variables and Secrets → Secret болгож хадгална. Энд бичихгүй.

const FEE_AB = 9000; // А, Б бүсийн хүргэлт

const OA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ck = (s) => { let t = 0; for (let i = 0; i < s.length; i++) t += (i + 1) * OA.indexOf(s[i]); return OA[t % 31]; };
// хуучин (бараа шингэсэн) код
const validCode = (c) => {
  if (!/^PT[0-9A-HJKMNP-TV-Z]{3,121}$/.test(c)) return false;
  const b = c.slice(2, -1);
  return b.length % 2 === 0 && ck(b) === c.slice(-1);
};

const json = (o, status = 200, h = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...h } });

let ready = false;
async function init(db) {
  if (ready) return;
  const run = (q) => db.prepare(q).run();
  await run("CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, t INTEGER NOT NULL, code TEXT NOT NULL, name TEXT, phone TEXT, items TEXT, total INTEGER, paid INTEGER DEFAULT 0, src TEXT, iph TEXT)");
  await run("CREATE INDEX IF NOT EXISTS orders_t ON orders (t)");
  await run("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
  await run("CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, data TEXT NOT NULL, del INTEGER DEFAULT 0, t INTEGER, n INTEGER)");
  await run("CREATE TABLE IF NOT EXISTS imgs (id TEXT PRIMARY KEY, type TEXT, b64 TEXT NOT NULL, t INTEGER)");
  const v = await db.prepare("SELECT v FROM meta WHERE k = 'schema'").first("v");
  if (+v < 2) {
    // өмнөх захиалгууд «Шилжүүлсэн» дарсны дараа хадгалагддаг байсан тул sent=1
    for (const c of ["zone TEXT", "addr TEXT", "fee INTEGER DEFAULT 0", "sent INTEGER DEFAULT 1", "tok TEXT", "num INTEGER"]) {
      try { await run("ALTER TABLE orders ADD COLUMN " + c); } catch (e) { /* аль хэдийн байгаа */ }
    }
    await run("CREATE UNIQUE INDEX IF NOT EXISTS orders_num ON orders (num)");
    await run("INSERT INTO meta (k, v) VALUES ('schema', '2') ON CONFLICT(k) DO UPDATE SET v = '2'");
  }
  ready = true;
}

async function sha(buf, n = 16) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].slice(0, n).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const hash = (s) => sha(new TextEncoder().encode(s), 8);
const rnd = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");

// null: нууц үг тохируулаагүй, false: буруу, true: зөв
function isOwner(req, env) {
  const key = env.ADMIN_KEY;
  if (!key) return null;
  const h = req.headers.get("authorization") || "";
  const got = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (got.length !== key.length) return false;
  let d = 0;
  for (let i = 0; i < key.length; i++) d |= key.charCodeAt(i) ^ got.charCodeAt(i);
  return d === 0;
}

const str = (x, n) => String(x == null ? "" : x).replace(/\s+/g, " ").trim().slice(0, n);
const int = (x, max = 100000000) => Math.max(0, Math.min(max, Math.round(+x || 0)));
function tidyItem(x) {
  if (typeof x === "string") return str(x, 160);
  if (!x || typeof x !== "object") return null;
  const k = String(x.k || "");
  return { k: /^[A-Z]{1,2}\d{2,6}(:\d{1,2})?$/.test(k) ? k : "", t: str(x.t, 160), q: Math.max(1, Math.min(99, int(x.q) || 1)), p: int(x.p) };
}
function tidy(b) {
  const name = str(b.name, 80);
  const phone = String(b.phone || "").replace(/\D/g, "").slice(0, 8);
  const items = Array.isArray(b.items) ? b.items.slice(0, 60).map(tidyItem).filter(Boolean) : [];
  const total = int(b.total);
  return { name, phone, items, total };
}

async function body(req) {
  try { const b = await req.json(); return b && typeof b === "object" && !Array.isArray(b) ? b : null; } catch { return null; }
}

const ORD_COLS = "id, t, code, name, phone, items, total, paid, src, zone, addr, fee, sent";
const outOrder = (o) => {
  let items = [];
  try { items = JSON.parse(o.items || "[]"); } catch {}
  return { ...o, items, paid: !!o.paid, sent: o.sent == null ? true : !!o.sent, fee: o.fee || 0 };
};

async function bump(db) {
  await db.prepare("INSERT INTO meta (k, v) VALUES ('cv', '1') ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + 1").run();
}

// бараа: нэр, үнэ, хэсэг, ангилал, өнгө/зураг
function tidyProduct(d) {
  if (!d || typeof d !== "object") return null;
  const v = Array.isArray(d.v) ? d.v.slice(0, 24).map((x) => ({
    c: str(x && x.c, 40),
    img: x && /^[0-9a-f]{16,64}$/.test(String(x.img || "")) ? String(x.img) : null,
    b: x && Number.isInteger(x.b) && x.b >= 0 && x.b < 64 ? x.b : null, // үндсэн барааны хэддүгээр зураг
  })) : undefined;
  const o = { name: str(d.name, 80), price: d.price === null || d.price === "" || d.price === undefined ? null : int(d.price), dept: str(d.dept, 40), sub: str(d.sub, 40) };
  if (v) o.v = v;
  return o;
}

async function api(req, env, url) {
  if (!env.DB) return json({ error: "no_db" }, 503);
  await init(env.DB);
  const DB = env.DB;
  const path = url.pathname.replace(/\/+$/, "");
  const M = req.method;

  // ---------- нийтэд нээлттэй ----------
  if (path === "/api/catalog" && M === "GET") {
    const cv = (await DB.prepare("SELECT v FROM meta WHERE k = 'cv'").first("v")) || "0";
    const tag = '"c' + cv + '"';
    if (req.headers.get("if-none-match") === tag) return new Response(null, { status: 304, headers: { etag: tag, "cache-control": "no-cache" } });
    const r = await DB.prepare("SELECT id, data, del, n FROM products ORDER BY COALESCE(n, 0), id").all();
    const items = (r.results || []).map((x) => { let d = {}; try { d = JSON.parse(x.data); } catch {} return { id: x.id, del: !!x.del, n: x.n || 0, ...d }; });
    return json({ cv: +cv, fee: FEE_AB, items }, 200, { etag: tag, "cache-control": "no-cache" });
  }

  if (path === "/api/orders" && M === "POST") {
    const b = await body(req);
    if (!b) return json({ error: "bad_json" }, 400);
    const iph = await hash((req.headers.get("cf-connecting-ip") || "") + "|" + new Date().toISOString().slice(0, 10));
    const limited = async () => (await DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE iph = ? AND t > ?").bind(iph, Date.now() - 10 * 60 * 1000).first("n")) >= 8;

    // хуучин хувилбар (бараа шингэсэн код, «Шилжүүлсэн» дарсны дараа илгээдэг)
    if (!("zone" in b)) {
      const code = String(b.code || "").toUpperCase();
      if (!validCode(code)) return json({ error: "bad_code" }, 400);
      const o = tidy(b);
      if (!o.name || o.phone.length !== 8) return json({ error: "bad_contact" }, 400);
      if (await limited()) return json({ error: "too_many" }, 429);
      const id = crypto.randomUUID();
      await DB.prepare("INSERT INTO orders (id, t, code, name, phone, items, total, paid, src, iph, sent) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'site', ?, 1)")
        .bind(id, Date.now(), code, o.name, o.phone, JSON.stringify(o.items), o.total, iph).run();
      return json({ ok: true, id, code });
    }

    const o = tidy(b);
    const zone = b.zone === "ab" ? "ab" : "other";
    const addr = String(b.addr || "").replace(/[ \t]+/g, " ").trim().slice(0, 300);
    if (!o.name || o.phone.length !== 8) return json({ error: "bad_contact" }, 400);
    if (!addr) return json({ error: "bad_addr" }, 400);
    if (!o.items.length) return json({ error: "empty" }, 400);
    const fee = zone === "ab" ? FEE_AB : 0;
    const goods = o.items.reduce((s, x) => s + (typeof x === "object" ? x.p * x.q : 0), 0);
    const total = goods + fee;
    const items = JSON.stringify(o.items);

    // буцаж засаад дахин үргэлжлүүлбэл: нөгөө л захиалгыг шинэчилнэ
    if (typeof b.id === "string" && typeof b.tok === "string" && b.tok.length >= 16) {
      const u = await DB.prepare("UPDATE orders SET name = ?, phone = ?, items = ?, total = ?, zone = ?, addr = ?, fee = ?, t = ? WHERE id = ? AND tok = ? AND paid = 0")
        .bind(o.name, o.phone, items, total, zone, addr, fee, Date.now(), b.id, b.tok).run();
      if (u.meta && u.meta.changes) {
        const code = await DB.prepare("SELECT code FROM orders WHERE id = ?").bind(b.id).first("code");
        return json({ ok: true, id: b.id, tok: b.tok, code, total, fee });
      }
    }
    if (await limited()) return json({ error: "too_many" }, 429);
    const id = crypto.randomUUID(), tok = rnd();
    await DB.prepare(
      "INSERT INTO orders (id, t, code, name, phone, items, total, paid, src, iph, zone, addr, fee, sent, tok, num) " +
      "SELECT ?, ?, 'PT' || (COALESCE(MAX(num), 1000) + 1), ?, ?, ?, ?, 0, 'site', ?, ?, ?, ?, 0, ?, COALESCE(MAX(num), 1000) + 1 FROM orders"
    ).bind(id, Date.now(), o.name, o.phone, items, total, iph, zone, addr, fee, tok).run();
    const code = await DB.prepare("SELECT code FROM orders WHERE id = ?").bind(id).first("code");
    return json({ ok: true, id, tok, code, total, fee });
  }

  const sent = path.match(/^\/api\/orders\/([0-9a-f-]{36})\/sent$/);
  if (sent && M === "POST") {
    const b = await body(req);
    if (!b || typeof b.tok !== "string") return json({ error: "bad_json" }, 400);
    const u = await DB.prepare("UPDATE orders SET sent = 1 WHERE id = ? AND tok = ?").bind(sent[1], b.tok).run();
    return u.meta && u.meta.changes ? json({ ok: true }) : json({ error: "not_found" }, 404);
  }

  // ---------- доорхи бүгд зөвхөн эзэнд ----------
  const owner = isOwner(req, env);
  if (owner === null) return json({ error: "no_admin_key" }, 503);
  if (!owner) return json({ error: "unauthorized" }, 401);

  if (path === "/api/orders" && M === "GET") {
    const r = await DB.prepare("SELECT " + ORD_COLS + " FROM orders ORDER BY t DESC LIMIT 2000").all();
    return json({ orders: (r.results || []).map(outOrder) });
  }
  if (path === "/api/orders/manual" && M === "POST") {
    const b = await body(req);
    const list = b && Array.isArray(b.orders) ? b.orders.slice(0, 50) : [];
    let n = 0;
    for (const x of list) {
      const code = String((x && x.code) || "").toUpperCase();
      if (!validCode(code)) continue;
      const o = tidy(x);
      await DB.prepare("INSERT INTO orders (id, t, code, name, phone, items, total, paid, src, iph, sent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'bank', '', 1)")
        .bind(crypto.randomUUID(), Date.now() + n, code, o.name, o.phone, JSON.stringify(o.items), o.total, x.paid === false ? 0 : 1).run();
      n++;
    }
    return json({ ok: true, added: n });
  }
  const m = path.match(/^\/api\/orders\/([0-9a-f-]{36})$/);
  if (m && M === "PATCH") {
    const b = await body(req);
    if (!b) return json({ error: "bad_json" }, 400);
    await DB.prepare("UPDATE orders SET paid = ? WHERE id = ?").bind(b.paid ? 1 : 0, m[1]).run();
    return json({ ok: true });
  }
  if (m && M === "DELETE") {
    await DB.prepare("DELETE FROM orders WHERE id = ?").bind(m[1]).run();
    return json({ ok: true });
  }

  if (path === "/api/img" && M === "POST") {
    const type = (req.headers.get("content-type") || "").split(";")[0].trim();
    if (!/^image\/(webp|jpeg|png)$/.test(type)) return json({ error: "bad_type" }, 400);
    const buf = await req.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > 1400000) return json({ error: "too_big" }, 413);
    const id = await sha(buf);
    const u8 = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    await DB.prepare("INSERT OR IGNORE INTO imgs (id, type, b64, t) VALUES (?, ?, ?, ?)").bind(id, type, btoa(s), Date.now()).run();
    return json({ ok: true, id });
  }
  if (path === "/api/products" && M === "POST") {
    const b = await body(req);
    const d = tidyProduct(b && b.data);
    if (!d || !d.name || !d.v || !d.v.length || d.v.some((x) => !x.img)) return json({ error: "bad_product" }, 400);
    const n = ((await DB.prepare("SELECT MAX(n) AS n FROM products").first("n")) || 0) + 1;
    const id = "N" + String(n).padStart(4, "0");
    await DB.prepare("INSERT INTO products (id, data, del, t, n) VALUES (?, ?, 0, ?, ?)").bind(id, JSON.stringify(d), Date.now(), n).run();
    await bump(DB);
    return json({ ok: true, id });
  }
  const pm = path.match(/^\/api\/products\/(PR\d{3}|KC\d{3}|N\d{4,6}|_pd)$/);
  if (pm && M === "PUT") {
    const b = await body(req);
    if (!b) return json({ error: "bad_json" }, 400);
    const id = pm[1];
    const cur = await DB.prepare("SELECT data, del, n FROM products WHERE id = ?").bind(id).first();
    if (!cur && id[0] === "N") return json({ error: "not_found" }, 404);
    let data = cur ? cur.data : "{}";
    if ("data" in b) {
      if (id === "_pd") {
        data = JSON.stringify(b.data && typeof b.data === "object" ? b.data : {});
        if (data.length > 200000) return json({ error: "too_big" }, 413);
      } else {
        const d = tidyProduct(b.data);
        if (!d) return json({ error: "bad_product" }, 400);
        if (id[0] === "N" && (!d.v || !d.v.length || d.v.some((x) => !x.img))) return json({ error: "bad_product" }, 400);
        data = JSON.stringify(d);
      }
    }
    const del = "del" in b ? (b.del ? 1 : 0) : cur ? cur.del : 0;
    await DB.prepare("INSERT INTO products (id, data, del, t, n) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, del = excluded.del, t = excluded.t")
      .bind(id, data, del, Date.now(), cur ? cur.n : null).run();
    await bump(DB);
    return json({ ok: true, id });
  }
  return json({ error: "not_found" }, 404);
}

async function img(id, env, req) {
  let cache = null;
  try { cache = caches.default; const hit = await cache.match(req); if (hit) return hit; } catch { cache = null; }
  if (!env.DB) return new Response("Not found", { status: 404 });
  await init(env.DB);
  const r = await env.DB.prepare("SELECT type, b64 FROM imgs WHERE id = ?").bind(id).first();
  if (!r) return new Response("Not found", { status: 404 });
  const bin = atob(r.b64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const res = new Response(u8, { headers: { "content-type": r.type, "cache-control": "public, max-age=31536000, immutable" } });
  if (cache) { try { await cache.put(req, res.clone()); } catch {} }
  return res;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(req, env, url); } catch (e) { return json({ error: "server" }, 500); }
    }
    const im = url.pathname.match(/^\/img\/([0-9a-f]{16,64})$/);
    if (im && req.method === "GET") {
      try { return await img(im[1], env, req); } catch (e) { return new Response("Error", { status: 500 }); }
    }
    return env.ASSETS.fetch(req);
  },
};
