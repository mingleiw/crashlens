module.exports = (db) => () => ({ status: "ok", pool: db.size });
