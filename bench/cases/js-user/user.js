class User {
  constructor(raw) {
    this.id = raw.id;
    this.displayName = raw.displayName;
    this.email = raw.email;
    this.role = raw.role;
  }
}

module.exports = { User };
