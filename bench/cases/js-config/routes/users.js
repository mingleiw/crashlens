const USERS = [{ id: 1, name: "Ada" }];
module.exports = () => (id) => USERS.find((u) => u.id === id) || null;
