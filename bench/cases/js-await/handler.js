const { getUser } = require("./db");
const { badge } = require("./format");

async function profile(req) {
  const user = getUser(req.id);
  return { title: badge(user) };
}

profile({ id: 7 }).then((r) => console.log(r));
