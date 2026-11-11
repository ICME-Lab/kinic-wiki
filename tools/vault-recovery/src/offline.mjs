import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
const deny = () => {
  throw Error("NetworkForbidden");
};
net.connect = deny;
net.createConnection = deny;
net.Socket.prototype.connect = deny;
tls.connect = deny;
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
dgram.createSocket = deny;
dns.lookup = deny;
dns.resolve = deny;
globalThis.fetch = deny;
globalThis.WebSocket = class {
  constructor() {
    deny();
  }
};
syncBuiltinESMExports();
