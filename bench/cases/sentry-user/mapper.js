function toProfile(body) {
  const [first, ...rest] = body.userName.split(" ");
  return { first, last: rest.join(" "), email: body.email };
}

module.exports = { toProfile };
