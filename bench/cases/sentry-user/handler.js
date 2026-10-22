const { toProfile } = require("./mapper");

// Profiles come from the identity service; invited users may not have a name yet.
async function onSignup(req) {
  const profile = toProfile(req.body);
  return { status: 201, profile };
}

module.exports = { onSignup };
