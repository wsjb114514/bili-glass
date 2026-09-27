'use strict';
/**
 * 只读 SQLite 适配器：优先 Node 内置 node:sqlite（零依赖），
 * 不可用时回退到 sql.js（WASM，纯 JS）。
 */
const fs = require('fs');
const path = require('path');

let nodeSqlite = null;
let nodeSqliteTried = false;

function tryNodeSqlite() {
  if (nodeSqliteTried) return nodeSqlite;
  nodeSqliteTried = true;
  try {
    nodeSqlite = require('node:sqlite');
  } catch {
    nodeSqlite = null;
  }
  return nodeSqlite;
}

function readViaNodeSqlite(file, sql) {
  const { DatabaseSync } = tryNodeSqlite();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

function readViaSqlJs(file, sql) {
  const initSqlJs = require('sql.js');
  let wasmBinary;
  try {
    wasmBinary = fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
  } catch {
    wasmBinary = undefined;
  }
  return initSqlJs({ wasmBinary }).then((SQL) => {
    const db = new SQL.Database(fs.readFileSync(file));
    try {
      const res = db.exec(sql);
      if (!res.length) return [];
      const { columns, values } = res[0];
      return values.map((row) => {
        const obj = {};
        columns.forEach((c, i) => (obj[c] = row[i]));
        return obj;
      });
    } finally {
      db.close();
    }
  });
}

/**
 * @param {string} file sqlite 文件路径（建议传副本，避免被占用锁住）
 * @param {string} sql
 * @returns {Promise<object[]>}
 */
async function readRows(file, sql) {
  if (tryNodeSqlite()) {
    try {
      return readViaNodeSqlite(file, sql);
    } catch {
      /* 回退 sql.js */
    }
  }
  return readViaSqlJs(file, sql);
}

module.exports = { readRows };
