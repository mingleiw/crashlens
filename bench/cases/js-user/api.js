const sample = require("./fixtures/user.json");

function fetchUser(id) {
  return { ...sample, id };
}

module.exports = { fetchUser };
