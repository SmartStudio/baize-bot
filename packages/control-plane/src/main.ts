import { connect } from "./db/client.js";
import { databaseUrl, port, runtimeConfig, secureCookie } from "./env.js";
import { startServer } from "./server.js";

const { db } = connect(databaseUrl());
const server = await startServer({
  db,
  port: port(),
  secureCookie: secureCookie(),
  config: runtimeConfig(),
});
console.log(`控制面在 http://localhost:${server.port}`);
