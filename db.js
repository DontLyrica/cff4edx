import Database from "better-sqlite3";

const db = new Database('economy.db');

db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    money INTEGER DEFAULT 0,
    lastDaily INTEGER DEFAULT 0
  )
`).run();

export default {
  getUser(id) {
    const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
    if (!row) {
      db.prepare(`INSERT INTO users (id) VALUES (?)`).run(id);
      return { id, money: 0, lastDaily: 0 };
    }
    return row;
  },
  setMoney(id, amount) {
    db.prepare(`UPDATE users SET money = ? WHERE id = ?`).run(amount, id);
  },
  setDaily(id, time) {
    db.prepare(`UPDATE users SET lastDaily = ? WHERE id = ?`).run(time, id);
  },
  addMoney(id, amount) {
    db.prepare(`UPDATE users SET money = money + ? WHERE id = ?`).run(amount, id);
  },
  top() {
    return db.prepare(`SELECT * FROM users ORDER BY money DESC LIMIT 10`).all();
  }
};
