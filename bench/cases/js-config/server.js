const { loadConfig } = require("./config");
const { connect } = require("./db");
const health = require("./routes/health");

const config = loadConfig(process.env.NODE_ENV || "production");
const db = connect(config);
console.log(`listening on ${config.http.port}`, health(db)());
