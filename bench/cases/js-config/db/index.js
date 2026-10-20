const { createPool } = require("./pool");

function connect(config) {
  return createPool(config.db);
}

module.exports = { connect };
