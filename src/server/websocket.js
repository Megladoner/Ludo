'use strict';
const crypto = require('node:crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function acceptUpgrade(req, socket, head, onMessage, onClose) {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return null; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '\r\n'].join('\r\n'));
  const peer = { socket, buffer: Buffer.alloc(0), closed: false, send(value) { if (!this.closed && !socket.destroyed) socket.write(frame(0x1, Buffer.from(JSON.stringify(value)))); }, close(code = 1000) { if (!this.closed) { this.closed = true; try { socket.write(frame(0x8, Buffer.from([code >> 8, code & 255]))); } catch {} socket.end(); } } };
  socket.on('data', (chunk) => {
    peer.buffer = Buffer.concat([peer.buffer, chunk]);
    while (peer.buffer.length >= 2) {
      const b0 = peer.buffer[0], b1 = peer.buffer[1]; const opcode = b0 & 0x0f, masked = !!(b1 & 0x80);
      if (!masked) { peer.close(1002); return; }
      let length = b1 & 0x7f, offset = 2;
      if (length === 126) { if (peer.buffer.length < 4) return; length = peer.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (peer.buffer.length < 10) return; const big = peer.buffer.readBigUInt64BE(2); if (big > 65536n) { peer.close(1009); return; } length = Number(big); offset = 10; }
      const maskBytes = masked ? 4 : 0; if (peer.buffer.length < offset + maskBytes + length) return;
      const mask = masked ? peer.buffer.subarray(offset, offset + 4) : null; offset += maskBytes;
      const payload = Buffer.from(peer.buffer.subarray(offset, offset + length)); peer.buffer = peer.buffer.subarray(offset + length);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      if (opcode === 0x8) { peer.closed = true; socket.end(); return; }
      if (opcode === 0x9) { socket.write(frame(0xA, payload)); continue; }
      if (opcode === 0x1) { try { onMessage(peer, JSON.parse(payload.toString('utf8'))); } catch { peer.send({ type: 'error', error: 'Malformed message' }); } }
    }
  });
  let closeNotified = false;
  const notifyClose = () => { if (!closeNotified) { closeNotified = true; peer.closed = true; onClose(peer); } };
  socket.on('close', notifyClose); socket.on('error', notifyClose);
  if (head?.length) socket.emit('data', head);
  return peer;
}
function frame(opcode, payload) {
  const len = payload.length; let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}
module.exports = { acceptUpgrade };
