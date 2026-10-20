const rows = { 7: { id: 7, name: "Grace", plan: "pro" } };

async function getUser(id) {
  await new Promise((r) => setTimeout(r, 5));
  return rows[id];
}

module.exports = { getUser };
