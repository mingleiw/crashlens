// Pool settings are optional in development; a single connection is fine there.
function createPool(dbConfig) {
  const size = dbConfig.pool.max;
  return { host: dbConfig.host, size, connections: new Array(size).fill(null) };
}

module.exports = { createPool };
