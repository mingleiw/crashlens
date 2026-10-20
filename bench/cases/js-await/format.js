function badge(user) {
  return `${user.name.toUpperCase()} (${user.plan})`;
}

module.exports = { badge };
