/**
 * Minimal stand-in for the Python backend used by selftest-shell.mjs.
 *
 * It does exactly three things the shell relies on: binds a loopback port, announces it on stdout the
 * way memora/__main__.py does, and answers /api/agent/status with the identity fields the readiness
 * probe validates. The delay models a slow start without needing the real interpreter.
 */
import http from 'node:http';
import zlib from 'node:zlib';

const config = JSON.parse(process.argv[2]);
const server = http.createServer((request, response) => {
  if (request.url === '/api/agent/status') {
    const body = Buffer.from(JSON.stringify({name: 'memora', version: config.version, data_dir: config.dataDir}));
    // labelsGzip reproduces the real backend's defect deliberately: a zlib stream (78 9c) advertised
    // as gzip, which a client that honoured the header would reject. The probe asks for identity, so
    // it must still parse this.
    if (config.labelsGzip && String(request.headers['accept-encoding'] || '').includes('gzip')) {
      response.writeHead(200, {'content-type': 'application/json', 'content-encoding': 'gzip'});
      response.end(zlib.compress(body, 6));
      return;
    }
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(body);
    return;
  }
  response.writeHead(404);
  response.end();
});
// A failed backend must fail before it binds: the shell has to see the exit, not a socket.
if (config.fail) {
  console.error('deliberate startup failure');
  process.exit(3);
}
server.listen(config.port, '127.0.0.1', () => {
  const port = server.address().port;
  setTimeout(() => {
    if (config.announce) console.log('Memora: http://127.0.0.1:' + port);
  }, config.delayMs);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
