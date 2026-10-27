// PETAL store: захиалгын сан (Cloudflare D1).
// Сайтын файлуудыг (index.html) Cloudflare шууд өгнө; энэ код зөвхөн /api/... хаягийг хариуцна.
//   POST   /api/orders          худалдан авагч захиалгаа илгээнэ (нууц үг хэрэггүй)
//   GET    /api/orders          захиалгын жагсаалт        (эзний нууц үг: ADMIN_KEY)
//   POST   /api/orders/manual   гүйлгээнээс кодоор нэмэх   (эзний нууц үг)
//   PATCH  /api/orders/<id>     төлсөн / төлөөгүй          (эзний нууц үг)
//   DELETE /api/orders/<id>     устгах                     (эзний нууц үг)
// ADMIN_KEY-ийг Cloudflare дээр Settings → Variables and Secrets → Secret болгож хадгална. Энд бичихгүй.

const OA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ck = (s) => { let t = 0; for (let i = 0; i < s.length; i++) t += (i + 1) * OA.indexOf(s[i]); return OA[t % 31]; };
const validCode = (c) => {
  if (!/^PT[0-9A-HJKMNP-TV-Z]{3,121}$/.test(c)) return false;
  const b = c.slice(2, -1);
  return b.length % 2 === 0 && ck(b) === c.slice(-1);
};

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

let ready = false;
async function init(db) {
  if (ready) return;
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, t INTEGER NOT NULL, code TEXT NOT NULL, name TEXT, phone TEXT, items TEXT, total INTEGER, paid INTEGER DEFAULT 0, src TEXT, iph TEXT)"
  ).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS orders_t ON orders (t)").run();
  ready = true;
}

async function hash(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

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

function tidy(b) {
  const name = String(b.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const phone = String(b.phone || "").replace(/\D/g, "").slice(0, 8);
  const items = Array.isArray(b.items) ? b.items.slice(0, 60).map((x) => String(x).slice(0, 160)) : [];
  const total = Math.max(0, Math.min(100000000, Math.round(+b.total || 0)));
  return { name, phone, items, total };
}

async function body(req) {
  try { const b = await req.json(); return b && typeof b === "object" ? b : null; } catch { return null; }
}

async function api(req, env, url) {
  if (!env.DB) return json({ error: "no_db" }, 503);
  await init(env.DB);
  const path = url.pathname.replace(/\/+$/, "");

  // худалдан авагч: захиалга илгээх
  if (path === "/api/orders" && req.method === "POST") {
    const b = await body(req);
    if (!b) return json({ error: "bad_json" }, 400);
    const code = String(b.code || "").toUpperCase();
    if (!validCode(code)) return json({ error: "bad_code" }, 400);
    const o = tidy(b);
    if (!o.name || o.phone.length !== 8) return json({ error: "bad_contact" }, 400);
    const iph = await hash((req.headers.get("cf-connecting-ip") || "") + "|" + new Date().toISOString().slice(0, 10));
    const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE iph = ? AND t > ?").bind(iph, Date.now() - 10 * 60 * 1000).first("n");
    if (recent >= 8) return json({ error: "too_many" }, 429);
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO orders (id, t, code, name, phone, items, total, paid, src, iph) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'site', ?)")
      .bind(id, Date.now(), code, o.name, o.phone, JSON.stringify(o.items), o.total, iph).run();
    return json({ ok: true, id });
  }

  // доорхи бүгд зөвхөн эзэнд
  const owner = isOwner(req, env);
  if (owner === null) return json({ error: "no_admin_key" }, 503);
  if (!owner) return json({ error: "unauthorized" }, 401);

  if (path === "/api/orders" && req.method === "GET") {
    const r = await env.DB.prepare("SELECT id, t, code, name, phone, items, total, paid, src FROM orders ORDER BY t DESC LIMIT 1000").all();
    return json({ orders: (r.results || []).map((o) => ({ ...o, items: JSON.parse(o.items || "[]"), paid: !!o.paid })) });
  }
  if (path === "/api/orders/manual" && req.method === "POST") {
    const b = await body(req);
    const list = b && Array.isArray(b.orders) ? b.orders.slice(0, 50) : [];
    let n = 0;
    for (const x of list) {
      const code = String((x && x.code) || "").toUpperCase();
      if (!validCode(code)) continue;
      const o = tidy(x);
      await env.DB.prepare("INSERT INTO orders (id, t, code, name, phone, items, total, paid, src, iph) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'bank', '')")
        .bind(crypto.randomUUID(), Date.now() + n, code, o.name, o.phone, JSON.stringify(o.items), o.total, x.paid === false ? 0 : 1).run();
      n++;
    }
    return json({ ok: true, added: n });
  }
  const m = path.match(/^\/api\/orders\/([0-9a-f-]{36})$/);
  if (m && req.method === "PATCH") {
    const b = await body(req);
    if (!b) return json({ error: "bad_json" }, 400);
    await env.DB.prepare("UPDATE orders SET paid = ? WHERE id = ?").bind(b.paid ? 1 : 0, m[1]).run();
    return json({ ok: true });
  }
  if (m && req.method === "DELETE") {
    await env.DB.prepare("DELETE FROM orders WHERE id = ?").bind(m[1]).run();
    return json({ ok: true });
  }
  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(req, env, url); } catch (e) { return json({ error: "server" }, 500); }
    }
    return env.ASSETS.fetch(req);
  },
};
