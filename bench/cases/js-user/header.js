// Invited users have no display name until they finish signing up.
function initials(user) {
  return user.displayName
    .split(" ")
    .map((part) => part[0])
    .join("");
}

module.exports = { initials };
