// server.js
// Simple ticket booking system with seat locking and TTL
// Usage:
//   npm init -y
//   npm install express
//   node server.js
//
// Requires Node 14+ (async/await)

const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// ----- Simple Async Mutex (FIFO queue) -----
class Mutex {
  constructor() { this._queue = []; this._locked = false; }
  lock() {
    return new Promise(resolve => {
      if (!this._locked) {
        this._locked = true;
        resolve(() => this._unlock());
      } else {
        this._queue.push(resolve);
      }
    });
  }
  _unlock() {
    if (this._queue.length > 0) {
      const nextResolve = this._queue.shift();
      nextResolve(() => this._unlock());
    } else {
      this._locked = false;
    }
  }
}

// ----- In-memory seat store -----
/*
 seat = {
   id: 'A1',
   status: 'available' | 'locked' | 'booked',
   lockId: string|null,
   lockExpiresAt: timestamp|null
 }
*/
const seats = new Map();
const mutex = new Mutex();

// Initialize seats (simple grid A1..A5 rows A..C columns 1..5)
function initializeSeats() {
  const rows = ['A','B','C'];
  for (const r of rows) {
    for (let c = 1; c <= 5; c++) {
      const id = `${r}${c}`;
      seats.set(id, { id, status: 'available', lockId: null, lockExpiresAt: null });
    }
  }
}
initializeSeats();

// Background cleaner for expired locks (runs each second)
setInterval(() => {
  const now = Date.now();
  for (const s of seats.values()) {
    if (s.status === 'locked' && s.lockExpiresAt && s.lockExpiresAt <= now) {
      // expire lock
      s.status = 'available';
      s.lockId = null;
      s.lockExpiresAt = null;
      // (optionally: emit event/log)
      console.log(`Lock expired for seat ${s.id}`);
    }
  }
}, 1000);

// Helper: generate random lock id
function genLockId() {
  return crypto.randomBytes(12).toString('hex');
}

// ----- Routes -----
// Get all seats (with states)
app.get('/seats', (req, res) => {
  const result = Array.from(seats.values()).map(s => ({
    id: s.id,
    status: s.status,
    lockExpiresAt: s.lockExpiresAt
  }));
  res.json(result);
});

// Lock seats (atomic): body { seatIds: ["A1","A2"], ttlSeconds: 15 }
// Returns { success: true, lockId } or { success:false, reason, failedSeats }
app.post('/seats/lock', async (req, res) => {
  const seatIds = Array.isArray(req.body.seatIds) ? req.body.seatIds : [];
  const ttl = Number(req.body.ttlSeconds) || 15;
  if (!seatIds.length) return res.status(400).json({ success:false, reason:'seatIds required' });

  // Acquire mutex for atomicity
  const release = await mutex.lock();
  try {
    const now = Date.now();
    const failed = [];

    // First pass: ensure all seats exist and are currently available (or locked but expired)
    for (const id of seatIds) {
      const s = seats.get(id);
      if (!s) { failed.push({ id, reason: 'not_found' }); continue; }
      if (s.status === 'available') continue;
      if (s.status === 'locked' && s.lockExpiresAt && s.lockExpiresAt <= now) {
        // treat expired lock as available
        continue;
      }
      // otherwise locked or booked and not available
      failed.push({ id, reason: s.status === 'booked' ? 'already_booked' : 'locked' });
    }

    if (failed.length) {
      return res.status(409).json({ success:false, failedSeats: failed });
    }

    // All seats can be locked: create lockId and set lock fields
    const lockId = genLockId();
    const expiresAt = Date.now() + ttl * 1000;
    for (const id of seatIds) {
      const s = seats.get(id);
      // if previously locked but expired, reset first
      s.status = 'locked';
      s.lockId = lockId;
      s.lockExpiresAt = expiresAt;
    }

    return res.json({ success:true, lockId, expiresAt });
  } finally {
    release();
  }
});

// Confirm booking: body { lockId: 'abc', seatIds: [...] }
// Validates lock ownership and makes seats 'booked'
app.post('/seats/confirm', async (req, res) => {
  const lockId = req.body.lockId;
  const seatIds = Array.isArray(req.body.seatIds) ? req.body.seatIds : [];
  if (!lockId || !seatIds.length) return res.status(400).json({ success:false, reason:'lockId and seatIds required' });

  const release = await mutex.lock();
  try {
    const now = Date.now();
    const failed = [];

    // Validate that each seat is locked with this lockId and not expired
    for (const id of seatIds) {
      const s = seats.get(id);
      if (!s) { failed.push({ id, reason: 'not_found' }); continue; }
      if (s.status !== 'locked') { failed.push({ id, reason: 'not_locked' }); continue; }
      if (s.lockId !== lockId) { failed.push({ id, reason: 'lock_mismatch' }); continue; }
      if (!s.lockExpiresAt || s.lockExpiresAt <= now) { failed.push({ id, reason: 'lock_expired' }); continue; }
    }

    if (failed.length) {
      return res.status(409).json({ success:false, failedSeats: failed });
    }

    // All good: mark booked and clear lock fields
    for (const id of seatIds) {
      const s = seats.get(id);
      s.status = 'booked';
      s.lockId = null;
      s.lockExpiresAt = null;
    }

    return res.json({ success:true, bookedSeats: seatIds });
  } finally {
    release();
  }
});

// Release lock before TTL: body { lockId: 'abc', seatIds: [...] }
// Frees seats if they are locked by this lockId
app.post('/seats/release', async (req, res) => {
  const lockId = req.body.lockId;
  const seatIds = Array.isArray(req.body.seatIds) ? req.body.seatIds : [];
  if (!lockId || !seatIds.length) return res.status(400).json({ success:false, reason:'lockId and seatIds required' });

  const release = await mutex.lock();
  try {
    const result = [];
    for (const id of seatIds) {
      const s = seats.get(id);
      if (!s) { result.push({ id, result:'not_found' }); continue; }
      if (s.status !== 'locked') { result.push({ id, result:'not_locked' }); continue; }
      if (s.lockId !== lockId) { result.push({ id, result:'lock_mismatch' }); continue; }
      // release
      s.status = 'available';
      s.lockId = null;
      s.lockExpiresAt = null;
      result.push({ id, result:'released' });
    }
    return res.json({ success:true, details: result });
  } finally {
    release();
  }
});

// Get seat details for a single seat
app.get('/seats/:id', (req, res) => {
  const id = req.params.id;
  const s = seats.get(id);
  if (!s) return res.status(404).json({ error: 'not_found' });
  res.json({
    id: s.id,
    status: s.status,
    lockExpiresAt: s.lockExpiresAt
  });
});

// Simple health check
app.get('/health', (req, res) => res.json({ ok: true }));

// Start server
app.listen(PORT, () => {
  console.log(`Ticket API listening on http://localhost:${PORT}`);
  console.log('Seats: ', Array.from(seats.keys()).join(', '));
});

// ----- Optional: Simple demo of concurrent locking (uncomment to run automatically) -----
// This demo uses node's fetch global (Node 18+). If you want to run it, uncomment and execute `node server.js`.
// It simulates two concurrent clients trying to lock the same seat.

async function demoConcurrentLocking() {
  // Only run demo if explicitly requested via env var
  if (!process.env.DEMO) return;

  const fetch = global.fetch || (await import('node:node-fetch')).default;
  const url = `http://localhost:${PORT}`;
  const seatToTry = 'A1';

  // Two concurrent lock attempts
  const attempt = async (name) => {
    const resp = await fetch(`${url}/seats/lock`, {
      method: 'POST',
      headers: {'content-type':'application/json'},
      body: JSON.stringify({ seatIds: [seatToTry], ttlSeconds: 10 })
    });
    const body = await resp.json();
    console.log(`[${name}] status ${resp.status}`, body);
    return body;
  };

  // Wait 0.5s for server to be up
  await new Promise(r => setTimeout(r, 500));
  console.log('Starting concurrent demo: two clients try to lock seat A1 simultaneously.');

  const [r1, r2] = await Promise.all([attempt('Client1'), attempt('Client2')]);

  // If one got lock, confirm it
  const winner = r1.success ? r1 : (r2.success ? r2 : null);
  if (winner && winner.lockId) {
    console.log('Winner will confirm booking...');
    const confirmResp = await fetch(`${url}/seats/confirm`, {
      method: 'POST',
      headers: {'content-type':'application/json'},
      body: JSON.stringify({ lockId: winner.lockId, seatIds: [seatToTry] })
    });
    console.log('Confirm response:', await confirmResp.json());
  } else {
    console.log('No one could lock the seat (both failed).');
  }
}

// Optionally call demo (only if DEMO=1)
demoConcurrentLocking().catch(e => console.error('Demo err', e));
