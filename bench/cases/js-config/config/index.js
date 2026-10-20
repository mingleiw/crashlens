const defaults = require("./defaults");

function loadConfig(env) {
  const overrides = env === "production" ? require("./production") : {};
  return Object.assign({}, defaults, overrides);
}

module.exports = { loadConfig };
