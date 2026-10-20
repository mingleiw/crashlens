module.exports = {
  http: { port: 8080, timeoutMs: 5000 },
  db: { host: "localhost", port: 5432, pool: { min: 1, max: 10 } },
  log: { level: "info" },
};
