function settings(env) {
  const local = env === "development" ? require("./local") : {};
  return { ...require("./defaults"), ...local };
}

module.exports = { settings };
