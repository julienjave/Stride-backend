// A throwaway verification script, not part of the app — confirms
// WebSocket connections genuinely survive the real chain (Cloudflare ->
// Caddy -> Node), something curl can't test and no frontend exists yet to
// exercise. Run locally: node scripts/test-websocket-production.js "<cookie>"
const { io } = require('socket.io-client');

const cookie = process.argv[2];
if (!cookie) {
  console.error('Usage: node test-websocket-production.js "connect.sid=..."');
  process.exit(1);
}

const socket = io('https://api.stridecare.app', {
  transports: ['websocket'],
  extraHeaders: { Cookie: cookie },
});

const timeout = setTimeout(() => {
  console.log('FAILED: connection attempt did not resolve within 10s');
  process.exit(1);
}, 10000);

socket.on('connect', () => {
  clearTimeout(timeout);
  console.log('PASSED: WebSocket connected through the real chain (Cloudflare -> Caddy -> Node)');
  socket.close();
  process.exit(0);
});

socket.on('connect_error', (err) => {
  clearTimeout(timeout);
  console.log('FAILED: connect_error -', err.message);
  process.exit(1);
});