const users = [{ id: "u1", name: "Ada" }, { id: "u2", name: "Lin" }];

function findUser(id) {
  return users.find((u) => u.id === id);
}

function greeting(user) {
  return "Hello, " + user.name.toUpperCase();
}

function handle(req) {
  const user = findUser(req.userId);
  return greeting(user);
}

console.log(handle({ userId: "U1" }));
