require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const MASTER_PASSWORD    = process.env.MASTER_PASSWORD    || 'hogwarts2025';
const SPECTATOR_PASSWORD = process.env.SPECTATOR_PASSWORD || 'platibunda';

// ── In-memory state ──────────────────────────────────────────────────────────
const rooms = {}; // roomId → RoomState

function createRoom(roomId) {
  return {
    roomId,
    gameStatus: 'waiting', // waiting | playing | finished
    winner: null,
    players: {},           // playerId → PlayerState
    createdAt: Date.now(),
  };
}

function createPlayer(id, name, house, isMaster) {
  return {
    id, name, house, isMaster,
    found: [],        // indices of correctly found errors
    totalClicks: 0,
    wrongClicks: 0,   // consecutive wrong clicks (resets on correct)
    totalWrong: 0,    // total wrong clicks ever (for master display)
    lockedUntil: 0,   // timestamp — player blocked until this time
    clickLog: [],     // { x, y, correct, errorIndex, time }
    joinedAt: Date.now(),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function broadcast(roomId, payload, excludeWs = null) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN && ws.roomId === roomId && ws !== excludeWs) {
      ws.send(msg);
    }
  });
}

function broadcastToMasters(roomId, payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN && ws.roomId === roomId && ws.isMaster) {
      ws.send(msg);
    }
  });
}

function broadcastToSpectators(roomId, payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN && ws.roomId === roomId && ws.isSpectator) {
      ws.send(msg);
    }
  });
}

// Spectator-safe snapshot: player names + found count only, no click details
function spectatorSnapshot(room) {
  const players = Object.values(room.players)
    .filter(p => !p.isMaster && !p.isSpectator)
    .sort((a,b) => b.found.length - a.found.length || a.totalClicks - b.totalClicks)
    .map(p => ({
      id: p.id, name: p.name, house: p.house,
      found: p.found.length,   // only count, never indices
      totalClicks: p.totalClicks,
    }));
  return {
    type: 'spectator_state',
    gameStatus: room.gameStatus,
    totalErrors: TOTAL_ERRORS,
    players,
    winner: room.gameStatus === 'finished' ? room.winner : null,
  };
}

function roomSnapshot(room, forMaster = false) {
  const players = Object.values(room.players).map(p => ({
    id: p.id,
    name: p.name,
    house: p.house,
    isMaster: p.isMaster,
    found: p.found.length,
    totalClicks: forMaster ? p.totalClicks : undefined,
    totalWrong:  forMaster ? p.totalWrong  : undefined,
    lockedUntil: forMaster ? p.lockedUntil : undefined,
    clickLog:    forMaster ? p.clickLog    : undefined,
  }));

  return {
    type: 'room_state',
    roomId: room.roomId,
    gameStatus: room.gameStatus,
    winner: forMaster ? room.winner : (room.gameStatus === 'finished' ? room.winner : null),
    players,
  };
}

// ── Error positions — mapped from gabarito image (never sent to client) ──────
const ERRORS = [
  { x: 0.797, y: 0.157, r: 0.07 },  // SI #1  — top-right
  { x: 0.079, y: 0.180, r: 0.07 },  // SI #2  — top-left
  { x: 0.686, y: 0.312, r: 0.07 },  // SI #3  — center-right
  { x: 0.955, y: 0.460, r: 0.07 },  // SI #4  — far right
  { x: 0.585, y: 0.492, r: 0.07 },  // SI #5  — center
  { x: 0.130, y: 0.693, r: 0.07 },  // SI #6  — mid-left
  { x: 0.462, y: 0.781, r: 0.07 },  // SI #7  — center-bottom
  { x: 0.348, y: 0.837, r: 0.07 },  // SI #8  — lower-center
  { x: 0.131, y: 0.900, r: 0.07 },  // SI #9  — bottom-left
  { x: 0.652, y: 0.953, r: 0.07 },  // SI #10 — bottom-right
];
const TOTAL_ERRORS = ERRORS.length; // 10

function checkHit(xPct, yPct, found) {
  for (let i = 0; i < ERRORS.length; i++) {
    if (found.includes(i)) continue;
    const dx = xPct - ERRORS[i].x;
    const dy = yPct - ERRORS[i].y;
    if (Math.sqrt(dx * dx + dy * dy) < ERRORS[i].r) return i;
  }
  return -1;
}

// ── WebSocket protocol ───────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'join': {
        const { name, house, roomId, masterPassword, spectatorPassword } = msg;
        if (!roomId) {
          return ws.send(JSON.stringify({ type: 'error', text: 'Código da sala obrigatório.' }));
        }

        const isMaster     = masterPassword    === MASTER_PASSWORD;
        const isSpectator  = spectatorPassword === SPECTATOR_PASSWORD;

        // Password validation
        if (masterPassword   && !isMaster)    return ws.send(JSON.stringify({ type: 'error', text: 'Senha do Master incorreta!' }));
        if (spectatorPassword && !isSpectator) return ws.send(JSON.stringify({ type: 'error', text: 'Código de espectador incorreto!' }));

        // Non-spectator, non-master players need name + house
        if (!isSpectator && (!name || !house)) {
          return ws.send(JSON.stringify({ type: 'error', text: 'Dados incompletos.' }));
        }

        if (!rooms[roomId]) {
          if (!isMaster) {
            return ws.send(JSON.stringify({ type: 'error', text: 'Sala não encontrada. O Master deve entrar primeiro.' }));
          }
          rooms[roomId] = createRoom(roomId);
        }

        const room = rooms[roomId];

        // Block regular players from joining mid-game
        if (room.gameStatus === 'playing' && !isMaster && !isSpectator) {
          return ws.send(JSON.stringify({ type: 'error', text: 'O jogo já começou! Aguarde a próxima rodada.' }));
        }

        const playerId = crypto.randomUUID();

        if (!isSpectator) {
          const player = createPlayer(playerId, name, house, isMaster);
          room.players[playerId] = player;
        }

        ws.roomId     = roomId;
        ws.playerId   = playerId;
        ws.isMaster   = isMaster;
        ws.isSpectator = isSpectator;

        // Issue a one-use token so master can load gabarito image
        let gabaritoToken = null;
        if (isMaster) {
          gabaritoToken = crypto.randomBytes(24).toString('hex');
          masterTokens.add(gabaritoToken);
          setTimeout(() => masterTokens.delete(gabaritoToken), 10 * 60 * 1000);
        }

        ws.send(JSON.stringify({
          type: 'joined',
          playerId,
          isMaster,
          isSpectator,
          roomId,
          totalErrors: TOTAL_ERRORS,
          gabaritoToken,  // null for non-masters
        }));

        // Send initial state
        if (isSpectator) {
          ws.send(JSON.stringify(spectatorSnapshot(room)));
        } else {
          ws.send(JSON.stringify(roomSnapshot(room, isMaster)));
          broadcast(roomId, roomSnapshot(room, false), ws);
          broadcastToMasters(roomId, roomSnapshot(room, true));
        }
        break;
      }

      case 'master_start': {
        const room = rooms[ws.roomId];
        if (!room || !ws.isMaster) return;
        room.gameStatus = 'playing';
        broadcast(ws.roomId, { type: 'game_started' });
        ws.send(JSON.stringify({ type: 'game_started' }));
        broadcastToSpectators(ws.roomId, { type: 'game_started' });
        break;
      }

      case 'click': {
        const room = rooms[ws.roomId];
        if (!room || room.gameStatus !== 'playing') return;

        const player = room.players[ws.playerId];
        if (!player || player.isMaster) return;

        // ── Penalty check: is player currently locked? ──
        const now = Date.now();
        if (player.lockedUntil > now) {
          ws.send(JSON.stringify({
            type: 'locked',
            lockedUntil: player.lockedUntil,
            remaining: player.lockedUntil - now,
          }));
          return;
        }

        const { x, y } = msg;
        if (typeof x !== 'number' || typeof y !== 'number') return;
        const xPct = Math.max(0, Math.min(1, x));
        const yPct = Math.max(0, Math.min(1, y));

        player.totalClicks++;
        const hitIndex = checkHit(xPct, yPct, player.found);
        const isCorrect = hitIndex !== -1;

        if (isCorrect) {
          player.found.push(hitIndex);
          player.wrongStreak = 0; // reset consecutive streak on correct hit
        } else {
          player.wrongStreak = (player.wrongStreak || 0) + 1;
          player.totalWrong++;
          // Penalty only kicks in after 3 consecutive wrong clicks
          // Each additional wrong adds 1s (so: 3→1s, 4→2s, 5→3s … max 15s)
          if (player.wrongStreak >= 3) {
            const penaltyMs = Math.min((player.wrongStreak - 2) * 1000, 15000);
            player.lockedUntil = now + penaltyMs;
          }
        }

        player.clickLog.push({
          x: Math.round(xPct * 1000) / 1000,
          y: Math.round(yPct * 1000) / 1000,
          correct: isCorrect,
          errorIndex: isCorrect ? hitIndex : null,
          time: now,
        });

        // Reply to the clicker
        ws.send(JSON.stringify({
          type: 'click_result',
          correct: isCorrect,
          x: xPct, y: yPct,
          errorIndex: isCorrect ? hitIndex : null,
          found: player.found,
          totalClicks: player.totalClicks,
          // Send penalty info if wrong
          penaltyMs: (!isCorrect && player.wrongStreak >= 3)
            ? Math.min((player.wrongStreak - 2) * 1000, 15000) : 0,
          wrongStreak: player.wrongStreak || 0,
        }));

        // Check win condition
        if (player.found.length === TOTAL_ERRORS && !room.winner) {
          room.winner = {
            id: player.id,
            name: player.name,
            house: player.house,
            totalClicks: player.totalClicks,
            totalWrong: player.totalWrong,
            time: Date.now(),
          };
          // Tell everyone (no name revealed) that someone won
          broadcast(ws.roomId, { type: 'winner_detected' });
          broadcastToSpectators(ws.roomId, { type: 'winner_detected' });
          // Master gets full winner info privately (to show before announcing)
          broadcastToMasters(ws.roomId, {
            type: 'winner_ready',
            winner: room.winner,
          });
          // Tell the winner privately
          ws.send(JSON.stringify({ type: 'you_won' }));
        }

        // Update master scoreboard
        broadcastToMasters(ws.roomId, roomSnapshot(room, true));
        // Update all players' scoreboard (without click details)
        broadcast(ws.roomId, roomSnapshot(room, false));
        // Update spectators with safe snapshot
        broadcastToSpectators(ws.roomId, spectatorSnapshot(room));
        break;
      }

      case 'announce_winner': {
        const room = rooms[ws.roomId];
        if (!room || !ws.isMaster || !room.winner) return;
        room.gameStatus = 'finished';
        const ranking = Object.values(room.players)
          .filter(p => !p.isMaster && !p.isSpectator)
          .sort((a,b) => b.found.length - a.found.length || a.totalClicks - b.totalClicks)
          .map(p => ({
            name: p.name, house: p.house,
            found: p.found.length, totalClicks: p.totalClicks, totalWrong: p.totalWrong,
          }));
        const payload = { type: 'winner_announced', winner: room.winner, players: ranking };
        broadcast(ws.roomId, payload);
        ws.send(JSON.stringify(payload));
        // Spectators get winner + ranking too
        broadcastToSpectators(ws.roomId, payload);
        break;
      }

      case 'master_reset': {
        const room = rooms[ws.roomId];
        if (!room || !ws.isMaster) return;
        room.gameStatus = 'waiting';
        room.winner = null;
        Object.values(room.players).forEach(p => {
          p.found = [];
          p.totalClicks = 0;
          p.wrongClicks = 0;
          p.wrongStreak = 0;
          p.totalWrong  = 0;
          p.lockedUntil = 0;
          p.clickLog = [];
        });
        broadcast(ws.roomId, { type: 'game_reset' });
        ws.send(JSON.stringify({ type: 'game_reset' }));
        broadcastToSpectators(ws.roomId, { type: 'game_reset' });
        break;
      }

      case 'kick_player': {
        const room = rooms[ws.roomId];
        if (!room || !ws.isMaster) return;
        const { targetId } = msg;
        if (room.players[targetId]) {
          delete room.players[targetId];
          wss.clients.forEach(c => {
            if (c.playerId === targetId) {
              c.send(JSON.stringify({ type: 'kicked' }));
            }
          });
          broadcast(ws.roomId, roomSnapshot(room, false));
          broadcastToMasters(ws.roomId, roomSnapshot(room, true));
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!ws.roomId) return;
    const room = rooms[ws.roomId];
    if (!room) return;
    // Spectators are not in room.players — just disconnect silently
    if (!ws.isSpectator && ws.playerId) {
      delete room.players[ws.playerId];
      broadcast(ws.roomId, roomSnapshot(room, false));
      broadcastToMasters(ws.roomId, roomSnapshot(room, true));
    }
    if (Object.keys(room.players).length === 0) {
      delete rooms[ws.roomId];
    }
  });
});

// ── Heartbeat ────────────────────────────────────────────────────────────────
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ── Static files ─────────────────────────────────────────────────────────────
// Gabarito (original/black image) — only accessible with master token
const masterTokens = new Set();

// Master gets a short-lived token when they join to load the gabarito
app.get('/images/gabarito.webp', (req, res) => {
  const token = req.query.t;
  if (!token || !masterTokens.has(token)) {
    return res.status(403).send('Forbidden');
  }
  res.sendFile(path.join(__dirname, 'public/images/original.webp'));
});

// Regular game image is public
app.use('/images', express.static(path.join(__dirname, 'public/images'), {
  index: false,
  // Block direct access to original.webp
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('original.webp')) {
      res.status(403).end();
    }
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

// Expose token issuer — called via WS after join, stored server-side
// We add this to the join flow instead
module.exports = { masterTokens };

server.listen(PORT, () => {
  console.log(`\n⚡ Servidor de Hogwarts rodando em http://localhost:${PORT}`);
  console.log(`🔮 Senha do Master: ${MASTER_PASSWORD}`);
  console.log(`\nPressione Ctrl+C para encerrar.\n`);
});
