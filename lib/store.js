import sqlite3 from 'sqlite3';

let db;

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

export async function initStore() {
  sqlite3.verbose();
  db = new sqlite3.Database('seen.db');
  await runAsync('CREATE TABLE IF NOT EXISTS seen (key TEXT PRIMARY KEY, ts INTEGER)');
}

export async function alreadySeen(key) {
  try {
    await runAsync('INSERT INTO seen(key, ts) VALUES(?, ?)', [key, Date.now()]);
    return false; // pas vu
  } catch (e) {
    return true;  // déjà vu (contrainte PK)
  }
}
