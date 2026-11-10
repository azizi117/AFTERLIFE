import express from "express";
import crypto from "node:crypto";
import Database from "better-sqlite3";

const app = express();
app.use(express.json());
app.use(express.static("public"));
const db = new Database(process.env.DB_PATH || "afterlife.sqlite");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY, username TEXT, first_name TEXT,
  balance INTEGER NOT NULL DEFAULT 0, last_claim INTEGER NOT NULL DEFAULT 0,
  referred_by TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id TEXT NOT NULL,
  amount INTEGER NOT NULL, claimed_at INTEGER NOT NULL
);
`);

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const REWARD = 100;
const COOLDOWN = 24 * 60 * 60;

function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calculated = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(calculated, "hex"), Buffer.from(hash, "hex"))) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Math.floor(Date.now()/1000) - authDate > 86400) return null;
  try { return JSON.parse(params.get("user") || "null"); } catch { return null; }
}

function auth(req, res, next) {
  const user = verifyTelegramInitData(req.headers["x-telegram-init-data"]);
  if (!user?.id) return res.status(401).json({error:"Open this app inside Telegram to authenticate."});
  req.tgUser = user;
  next();
}
function ensureUser(user, startParam) {
  const id = String(user.id);
  const now = Math.floor(Date.now()/1000);
  const existing = db.prepare("SELECT telegram_id FROM users WHERE telegram_id=?").get(id);
  if (!existing) {
    let ref = null;
    if (startParam && startParam.startsWith("ref_")) {
      const candidate = startParam.slice(4);
      if (candidate !== id && db.prepare("SELECT telegram_id FROM users WHERE telegram_id=?").get(candidate)) ref = candidate;
    }
    db.prepare(`INSERT INTO users(telegram_id,username,first_name,referred_by,created_at)
      VALUES(?,?,?,?,?)`).run(id, user.username || "", user.first_name || "", ref, now);
  } else {
    db.prepare("UPDATE users SET username=?, first_name=? WHERE telegram_id=?")
      .run(user.username || "", user.first_name || "", id);
  }
  return db.prepare("SELECT * FROM users WHERE telegram_id=?").get(id);
}
app.get("/api/me", auth, (req,res) => {
  const start = req.query.startapp || "";
  const u = ensureUser(req.tgUser, start);
  const now = Math.floor(Date.now()/1000);
  const seconds = Math.max(0, COOLDOWN - (now-u.last_claim));
  const referrals = db.prepare("SELECT COUNT(*) AS n FROM users WHERE referred_by=?").get(u.telegram_id).n;
  res.json({name:u.first_name || u.username || "AFTERLIFE user", balance:u.balance,
    reward:REWARD, cooldownSeconds:seconds, referrals, symbol:"AFT"});
});
app.post("/api/claim", auth, (req,res) => {
  const u = ensureUser(req.tgUser, "");
  const now = Math.floor(Date.now()/1000);
  if (now-u.last_claim < COOLDOWN) {
    return res.status(429).json({error:"Next mining claim is not ready.", cooldownSeconds:COOLDOWN-(now-u.last_claim)});
  }
  const tx = db.transaction(() => {
    db.prepare("UPDATE users SET balance=balance+?, last_claim=? WHERE telegram_id=?").run(REWARD,now,u.telegram_id);
    db.prepare("INSERT INTO claims(telegram_id,amount,claimed_at) VALUES(?,?,?)").run(u.telegram_id,REWARD,now);
    if (u.referred_by) {
      const bonus = 5;
      db.prepare("UPDATE users SET balance=balance+? WHERE telegram_id=?").run(bonus,u.referred_by);
    }
  });
  tx();
  res.json({ok:true, added:REWARD, symbol:"AFT"});
});
app.get("/health", (_req,res)=>res.json({ok:true,app:"AFTERLIFE"}));
app.listen(PORT, ()=>console.log(`AFTERLIFE listening on ${PORT}`));
