const { settings } = require("./settings");

const s = settings(process.env.NODE_ENV || "development");
// Timeouts are optional; the default agent applies its own.
const timeouts = s.http.timeouts;
console.log(`read timeout ${timeouts.read}ms, port ${s.http.port}`);
