// A throwaway verification script for the joinConversation authorization
// fix — checks BOTH that an unrelated user is correctly rejected (with a
// real, meaningful error, not a generic one) AND that a genuine participant
// still works, so the fix isn't just breaking legitimate access outright.
//
// Usage: node scripts/test-websocket-join-auth.js <url> <cookie> <conversationId> <expect>
// <expect> is either "reject" or "allow"
const { io } = require('socket.io-client');

const [, , url, cookie, conversationIdRaw, expect] = process.argv;
if (!url || !cookie || !conversationIdRaw || !expect) {
  console.error('Usage: node test-websocket-join-auth.js <url> "<cookie>" <conversationId> <reject|allow>');
  process.exit(1);
}
const conversationId = Number(conversationIdRaw);

const socket = io(url, {
  transports: ['websocket'],
  extraHeaders: { Cookie: cookie },
});

const timeout = setTimeout(() => {
  console.log('FAILED: nothing happened within 5s (no success, no error event)');
  socket.close();
  process.exit(1);
}, 5000);

socket.on('connect', () => {
  socket.emit('joinConversation', { conversationId });

  // NestJS's WS exception filter emits an "exception" event to the client
  // socket carrying the real error — this is what we're listening for to
  // confirm the fix actually surfaces a meaningful message now, not a
  // generic one.
  socket.on('exception', (err) => {
    clearTimeout(timeout);
    const isRealRejection = err?.message === 'You are not a participant in this conversation';
    if (expect === 'reject') {
      if (isRealRejection) {
        console.log('PASSED: join correctly rejected with the real, specific message:', JSON.stringify(err));
      } else {
        console.log('FAILED: got AN error, but not the expected rejection message — likely a different bug:', JSON.stringify(err));
      }
      socket.close();
      process.exit(isRealRejection ? 0 : 1);
    } else {
      console.log('FAILED: expected the join to succeed, but got rejected:', JSON.stringify(err));
      socket.close();
      process.exit(1);
    }
  });

  // No error within a short window after emitting = the join was accepted.
  setTimeout(() => {
    clearTimeout(timeout);
    if (expect === 'allow') {
      console.log('PASSED: join succeeded with no error, as expected');
    } else {
      console.log('FAILED: expected rejection, but the join was silently accepted');
    }
    socket.close();
    process.exit(expect === 'allow' ? 0 : 1);
  }, 2000);
});

socket.on('connect_error', (err) => {
  clearTimeout(timeout);
  console.log('FAILED: connect_error -', err.message);
  process.exit(1);
});