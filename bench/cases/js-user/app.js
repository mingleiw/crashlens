const { fetchUser } = require("./api");
const { User } = require("./user");
const { initials } = require("./header");

const current = new User(fetchUser(3));
console.log(initials(current));
