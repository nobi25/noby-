const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; }
  normalize(args) { return args.length === 1 && Array.isArray(args[0]) ? args[0] : args; }
  execute(args) {
    const statement = this.db.raw.prepare(this.sql);
    statement.bind(this.normalize(args));
    return statement;
  }
  get(...args) {
    const statement = this.execute(args);
    const row = statement.step() ? statement.getAsObject() : undefined;
    statement.free();
    return row;
  }
  all(...args) {
    const statement = this.execute(args);
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    statement.free();
    return rows;
  }
  run(...args) {
    const statement = this.execute(args);
    while (statement.step()) {}
    statement.free();
    const idResult = this.db.raw.exec('SELECT last_insert_rowid() AS id');
    const lastInsertRowid = Number(idResult[0]?.values?.[0]?.[0] || 0);
    const changes = this.db.raw.getRowsModified();
    this.db.commitIfNeeded();
    return { lastInsertRowid, changes };
  }
}

class LocalDb {
  constructor(raw, file) { this.raw = raw; this.file = file; this.inTransaction = false; }
  exec(sql) { this.raw.exec(sql); this.commitIfNeeded(); }
  prepare(sql) { return new Statement(this, sql); }
  transaction(fn) {
    return (...args) => {
      this.raw.run('BEGIN IMMEDIATE');
      this.inTransaction = true;
      try {
        const result = fn(...args);
        this.raw.run('COMMIT');
        this.inTransaction = false;
        this.save();
        return result;
      } catch (error) {
        try { this.raw.run('ROLLBACK'); } finally { this.inTransaction = false; this.save(); }
        throw error;
      }
    };
  }
  commitIfNeeded() { if (!this.inTransaction) this.save(); }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, Buffer.from(this.raw.export()));
    fs.renameSync(temporary, this.file);
  }
}

async function openLocalDb(file) {
  const SQL = await initSqlJs({ locateFile: filename => require.resolve(`sql.js/dist/${filename}`) });
  let raw;
  if (fs.existsSync(file) && fs.statSync(file).size > 0) raw = new SQL.Database(new Uint8Array(fs.readFileSync(file)));
  else raw = new SQL.Database();
  raw.run('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON');
  return new LocalDb(raw, file);
}

module.exports = { openLocalDb };
