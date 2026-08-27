const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const CARDS_DATA = require('../data/cards.json');
const CARDS = {
  white: CARDS_DATA.filter(c => c.tipo === 'blanca'),
  black: CARDS_DATA.filter(c => c.tipo === 'negra'),
};
const WIN_SCORE = 5;
const HAND_SIZE = 10;

const app = express();
app.use(cors());
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ─── Estado global ─────────────────────────────────────────────────────────────
const rooms = {};

// ─── Helpers ───────────────────────────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function requiredCardCount(blackCard) {
  return blackCard && blackCard.doble_respuesta ? 2 : 1;
}

function generateRoomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      letters[Math.floor(Math.random() * letters.length)]
    ).join('');
  } while (rooms[code]);
  return code;
}

/**
 * Construye el estado público de la sala.
 * NUNCA expone las manos privadas de los jugadores.
 * La carta negra solo se revela desde la fase 'choosing' en adelante.
 * Las cartas enviadas solo se revelan en 'results' / 'game_over'.
 */
function publicRoom(room) {
  const pub = {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    hdpIndex: room.hdpIndex,
    players: room.players.map(({ hand, ...p }) => p),
    whiteDeckSize: room.whiteDeck.length,
    blackDeckSize: room.blackDeck.length,
    currentBlackCard: null,
    // submissionStatus solo incluye jugadores activos (no espectadores)
    submissionStatus: room.players
      .filter(p => !p.isSpectator)
      .map(p => ({
        id: p.id,
        name: p.name,
        hasSubmitted: !!(room.submissions || {})[p.id],
      })),
    lastRoundResult: null,
    revealedSubmissions: null,
    gameWinner: null,
    requiredCardCount: 1,
  };

  // Revelar carta negra solo desde 'choosing'
  if (['choosing', 'voting', 'results', 'game_over'].includes(room.phase)) {
    pub.currentBlackCard = room.currentBlackCard;
    pub.requiredCardCount = requiredCardCount(room.currentBlackCard);
  }

  // Revelar todas las respuestas al final de la ronda
  if (['results', 'game_over'].includes(room.phase)) {
    pub.lastRoundResult = room.lastRoundResult;
    pub.revealedSubmissions = (room.shuffledSubmissions || []).map(s => ({
      cards: s.cards.map(c => c.texto),
      playerName: room.players.find(p => p.id === s.playerId)?.name || '?',
      isWinner: s.playerId === room.lastRoundResult?.winnerPlayerId,
    }));
  }

  if (room.phase === 'game_over') {
    pub.gameWinner = room.gameWinner;
  }

  return pub;
}

/** Recarga los mazos si están vacíos o casi vacíos */
function refillDecks(room) {
  if (room.whiteDeck.length < room.players.length * HAND_SIZE) {
    room.whiteDeck = [...room.whiteDeck, ...shuffle([...CARDS.white])];
  }
  if (room.blackDeck.length === 0) {
    room.blackDeck = shuffle([...CARDS.black]);
  }
}

// ─── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`✅ Conectado: ${socket.id}`);

  // ── CREAR SALA ────────────────────────────────────────────────────────────────
  socket.on('create_room', ({ playerName, isSpectator }, cb) => {
    if (!playerName?.trim()) return cb({ success: false, error: 'Nombre requerido.' });

    const roomCode = generateRoomCode();
    const player = {
      id: socket.id,
      name: playerName.trim(),
      score: 0,
      hand: [],
      isSpectator: !!isSpectator
    };

    rooms[roomCode] = {
      code: roomCode,
      hostId: socket.id,
      phase: 'lobby',
      hdpIndex: 0,
      players: [player],
      whiteDeck: [],
      blackDeck: [],
      currentBlackCard: null,
      submissions: {},
      shuffledSubmissions: [],
      lastRoundResult: null,
      gameWinner: null,
    };

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerName = playerName.trim();
    socket.data.isSpectator = !!isSpectator;

    console.log(`🏠 Sala creada: ${roomCode} por ${playerName}${isSpectator ? ' (espectador)' : ''}`);
    cb({ success: true, roomCode, playerId: socket.id, isSpectator: !!isSpectator });
    io.to(roomCode).emit('room_updated', publicRoom(rooms[roomCode]));
  });

  // ── UNIRSE A SALA ──────────────────────────────────────────────────────────────
  socket.on('join_room', ({ roomCode, playerName, isSpectator }, cb) => {
    const code = roomCode?.trim().toUpperCase();
    if (!playerName?.trim()) return cb({ success: false, error: 'Nombre requerido.' });
    if (!rooms[code]) return cb({ success: false, error: `Sala "${code}" no encontrada.` });
    if (rooms[code].phase !== 'lobby') return cb({ success: false, error: 'La partida ya comenzó.' });
    if (rooms[code].players.length >= 10) return cb({ success: false, error: 'Sala llena (máx. 10).' });

    const player = {
      id: socket.id,
      name: playerName.trim(),
      score: 0,
      hand: [],
      isSpectator: !!isSpectator,
    };
    rooms[code].players.push(player);

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerName = playerName.trim();
    socket.data.isSpectator = !!isSpectator;

    console.log(`👋 ${playerName} se unió a sala ${code}${isSpectator ? ' (espectador)' : ''}`);
    cb({ success: true, roomCode: code, playerId: socket.id, isSpectator: !!isSpectator });
    io.to(code).emit('room_updated', publicRoom(rooms[code]));
  });

  // ── INICIAR PARTIDA ────────────────────────────────────────────────────────────
  socket.on('start_game', (_, cb) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return cb({ success: false, error: 'Sala no encontrada.' });
    if (room.hostId !== socket.id) return cb({ success: false, error: 'Solo el host puede iniciar.' });
    if (room.players.length < 2) return cb({ success: false, error: 'Mínimo 2 jugadores.' });
    if (room.phase !== 'lobby') return cb({ success: false, error: 'Partida ya iniciada.' });

    // Mínimo 2 jugadores activos (sin contar espectadores)
    const activePlayers = room.players.filter(p => !p.isSpectator);
    if (activePlayers.length < 2) return cb({ success: false, error: 'Mínimo 2 jugadores.' });

    // Resetear y barajar mazos
    room.whiteDeck = shuffle([...CARDS.white]);
    room.blackDeck = shuffle([...CARDS.black]);
    const firstActiveIdx = room.players.findIndex(p => !p.isSpectator);
    room.hdpIndex = firstActiveIdx !== -1 ? firstActiveIdx : 0;
    room.submissions = {};
    room.shuffledSubmissions = [];
    room.lastRoundResult = null;
    room.gameWinner = null;
    room.players.forEach(p => { p.score = 0; p.hand = []; });

    // Repartir 10 cartas solo a jugadores activos (no espectadores)
    activePlayers.forEach(p => {
      p.hand = room.whiteDeck.splice(0, HAND_SIZE);
      io.to(p.id).emit('your_hand', { hand: p.hand.map(c => c.texto) });
    });

    // Sacar primera carta negra (sin revelar todavía)
    room.currentBlackCard = room.blackDeck.shift();
    room.phase = 'hdp_discard';

    console.log(`🎲 Partida iniciada: sala ${roomCode}`);
    io.to(roomCode).emit('room_updated', publicRoom(room));
    cb({ success: true });
  });

  // ── HDP CAMBIA CARTAS (antes de revelar consigna) ─────────────────────────────
  socket.on('hdp_swap_cards', ({ indices }, cb) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.phase !== 'hdp_discard') return cb({ success: false, error: 'Fase incorrecta.' });

    const hdp = room.players[room.hdpIndex];
    if (!hdp || hdp.id !== socket.id) return cb({ success: false, error: 'No sos el HDP.' });

    const validIndices = [...new Set(indices)].filter(
      i => Number.isInteger(i) && i >= 0 && i < hdp.hand.length
    );

    if (validIndices.length === 0) return cb({ success: true, swapped: 0 });

    // Cambiar cartas seleccionadas por nuevas del mazo
    const count = Math.min(validIndices.length, room.whiteDeck.length);
    const newCards = room.whiteDeck.splice(0, count);
    hdp.hand = hdp.hand.filter((_, i) => !validIndices.includes(i));
    hdp.hand = [...hdp.hand, ...newCards];

    io.to(socket.id).emit('your_hand', { hand: hdp.hand.map(c => c.texto) });
    console.log(`🔄 ${hdp.name} cambió ${count} carta(s) en sala ${roomCode}`);
    cb({ success: true, swapped: count });
  });

  // ── HDP LISTO: revela la carta negra a todos ───────────────────────────────────
  socket.on('hdp_ready', (_, cb) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.phase !== 'hdp_discard') return cb({ success: false, error: 'Fase incorrecta.' });

    const hdp = room.players[room.hdpIndex];
    if (!hdp || hdp.id !== socket.id) return cb({ success: false, error: 'No sos el HDP.' });

    room.phase = 'choosing';
    room.submissions = {};
    room.shuffledSubmissions = [];

    console.log(`📋 Carta negra revelada en ${roomCode}: "${room.currentBlackCard}"`);
    io.to(roomCode).emit('room_updated', publicRoom(room));
    cb({ success: true });
  });

  // ── JUGADOR ENVÍA SU CARTA BLANCA ──────────────────────────────────────────────
  socket.on('submit_card', ({ cardIndices }, cb) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.phase !== 'choosing') return cb({ success: false, error: 'Fase incorrecta.' });

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return cb({ success: false, error: 'Jugador no encontrado.' });

    const hdp = room.players[room.hdpIndex];
    if (hdp.id === socket.id) return cb({ success: false, error: 'El HDP no envía cartas.' });
    if (room.submissions[socket.id]) return cb({ success: false, error: 'Ya enviaste tu respuesta.' });

    const expectedCount = requiredCardCount(room.currentBlackCard);
    if (!Array.isArray(cardIndices) || cardIndices.length !== expectedCount) {
      return cb({ success: false, error: `Debes enviar exactamente ${expectedCount} carta(s).` });
    }

    // Verificar índices válidos
    const hasInvalid = cardIndices.some(idx => typeof idx !== 'number' || idx < 0 || idx >= player.hand.length);
    if (hasInvalid) {
      return cb({ success: false, error: 'Cartas seleccionadas inválidas.' });
    }

    // Asegurarse de que no haya índices duplicados en el envío
    const uniqueIndices = [...new Set(cardIndices)];
    if (uniqueIndices.length !== expectedCount) {
      return cb({ success: false, error: 'No puedes enviar la misma carta dos veces.' });
    }

    // Extraer cartas
    const submittedCards = cardIndices.map(idx => player.hand[idx]);
    room.submissions[socket.id] = submittedCards;

    // Remover del mazo del jugador (en orden inverso de índice para evitar que se desfacen)
    const sortedIndices = [...cardIndices].sort((a, b) => b - a);
    sortedIndices.forEach(idx => player.hand.splice(idx, 1));

    console.log(`🃏 ${player.name} envió ${expectedCount} carta(s) en ${roomCode}`);

    // Solo jugadores activos (sin HDP y sin espectadores) deben enviar
    const nonHdpActivePlayers = room.players.filter(p => p.id !== hdp.id && !p.isSpectator);
    const submittedCount = Object.keys(room.submissions).length;

    // Notificar progreso a todos
    io.to(roomCode).emit('room_updated', publicRoom(room));

    // Si todos los activos enviaron → fase de votación
    if (submittedCount >= nonHdpActivePlayers.length) {
      room.shuffledSubmissions = shuffle(
        Object.entries(room.submissions).map(([playerId, submCards]) => ({
          playerId,
          cards: Array.isArray(submCards) ? submCards : [submCards]
        }))
      );
      room.phase = 'voting';

      io.to(roomCode).emit('room_updated', publicRoom(room));
      // HDP recibe las cartas anónimas y mezcladas (cada entrada es string[])
      io.to(hdp.id).emit('voting_submissions', {
        submissions: room.shuffledSubmissions.map(s => s.cards.map(c => c.texto)),
      });
      // Los espectadores también reciben las cartas para mostrarlas en pantalla
      room.players
        .filter(p => p.isSpectator)
        .forEach(spectator => {
          io.to(spectator.id).emit('voting_submissions', {
            submissions: room.shuffledSubmissions.map(s => s.cards.map(c => c.texto)),
          });
        });
      console.log(`🗳️  Todos enviaron en ${roomCode} → votación`);
    }

    cb({ success: true });
  });

  // ── HDP ELIGE EL GANADOR ───────────────────────────────────────────────────────
  socket.on('pick_winner', ({ submissionIndex }, cb) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.phase !== 'voting') return cb({ success: false, error: 'Fase incorrecta.' });

    const hdp = room.players[room.hdpIndex];
    if (!hdp || hdp.id !== socket.id) return cb({ success: false, error: 'Solo el HDP puede elegir.' });

    const winner = room.shuffledSubmissions[submissionIndex];
    if (!winner) return cb({ success: false, error: 'Selección inválida.' });

    const winnerPlayer = room.players.find(p => p.id === winner.playerId);
    if (winnerPlayer) winnerPlayer.score++;

    room.lastRoundResult = {
      winnerName: winnerPlayer?.name || '?',
      winnerCards: winner.cards.map(c => c.texto),
      winnerPlayerId: winner.playerId,
    };

    // ¿Alguien llegó a 5 puntos?
    const gameWinner = room.players.find(p => p.score >= WIN_SCORE);
    if (gameWinner) {
      room.phase = 'game_over';
      room.gameWinner = gameWinner.name;
      console.log(`🏆 ${gameWinner.name} GANÓ el juego en sala ${roomCode}`);
    } else {
      room.phase = 'results';
    }

    console.log(`🏅 ${winnerPlayer?.name} ganó la ronda con: ${winner.cards.map(c => c.texto).join(' + ')}`);
    io.to(roomCode).emit('room_updated', publicRoom(room));
    cb({ success: true });
  });

  // ── SIGUIENTE RONDA ────────────────────────────────────────────────────────────
  socket.on('next_round', (_, cb) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return cb({ success: false, error: 'Sala no encontrada.' });
    if (room.hostId !== socket.id) return cb({ success: false, error: 'Solo el host puede continuar.' });
    if (room.phase !== 'results') return cb({ success: false, error: 'Fase incorrecta.' });

    // Rotar el HDP saltándose a los espectadores
    let nextIdx = room.hdpIndex;
    do {
      nextIdx = (nextIdx + 1) % room.players.length;
    } while (room.players[nextIdx].isSpectator && nextIdx !== room.hdpIndex);
    room.hdpIndex = nextIdx;

    // Reponer mazos si es necesario
    refillDecks(room);

    // Cada jugador activo roba hasta tener 10 cartas (los espectadores no tienen mano)
    room.players.forEach(p => {
      if (p.isSpectator) return;
      const needed = HAND_SIZE - p.hand.length;
      if (needed > 0) {
        p.hand = [...p.hand, ...room.whiteDeck.splice(0, Math.min(needed, room.whiteDeck.length))];
      }
      io.to(p.id).emit('your_hand', { hand: p.hand.map(c => c.texto) });
    });

    // Nueva carta negra (sin revelar)
    room.currentBlackCard = room.blackDeck.shift();
    room.phase = 'hdp_discard';
    room.submissions = {};
    room.shuffledSubmissions = [];
    room.lastRoundResult = null;

    console.log(`🔄 Nueva ronda en ${roomCode}. Nuevo HDP: ${room.players[room.hdpIndex].name}`);
    io.to(roomCode).emit('room_updated', publicRoom(room));
    cb({ success: true });
  });

  // ── JUGAR DE NUEVO (vuelve al lobby) ──────────────────────────────────────────
  socket.on('play_again', (_, cb) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return cb({ success: false, error: 'Sala no encontrada.' });
    if (room.hostId !== socket.id) return cb({ success: false, error: 'Solo el host puede reiniciar.' });
    if (room.phase !== 'game_over') return cb({ success: false, error: 'Fase incorrecta.' });

    room.phase = 'lobby';
    room.players.forEach(p => { p.score = 0; p.hand = []; });
    room.hdpIndex = 0;
    room.submissions = {};
    room.shuffledSubmissions = [];
    room.lastRoundResult = null;
    room.gameWinner = null;
    room.whiteDeck = [];
    room.blackDeck = [];
    room.currentBlackCard = null;

    console.log(`🔁 Sala ${roomCode} vuelve al lobby`);
    io.to(roomCode).emit('room_updated', publicRoom(room));
    cb({ success: true });
  });

  // ── ABANDONAR SALA ───────────────────────────────────────────────────────────
  socket.on('leave_room', (cb) => {
    const roomCode = socket.data?.roomCode;
    if (roomCode && rooms[roomCode]) {
      rooms[roomCode].players = rooms[roomCode].players.filter(
        (p) => p.id !== socket.id
      );

      socket.leave(roomCode);
      console.log(`👋 ${socket.data.playerName} abandonó sala ${roomCode}`);

      if (rooms[roomCode].players.length === 0) {
        delete rooms[roomCode];
        console.log(`🗑️  Sala ${roomCode} eliminada (vacía)`);
      } else {
        if (rooms[roomCode].hostId === socket.id) {
          rooms[roomCode].hostId = rooms[roomCode].players[0].id;
        }
        io.to(roomCode).emit('room_updated', publicRoom(rooms[roomCode]));
        io.to(roomCode).emit('player_left', { playerName: socket.data.playerName });
      }
    }
    socket.data.roomCode = null;
    if (cb) cb({ success: true });
  });

  // ── DESCONEXIÓN ────────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const roomCode = socket.data?.roomCode;
    if (!roomCode || !rooms[roomCode]) {
      console.log(`🔌 Desconectado: ${socket.id}`);
      return;
    }

    const room = rooms[roomCode];
    const leaving = room.players.find(p => p.id === socket.id);
    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
      delete rooms[roomCode];
      console.log(`🗑️  Sala ${roomCode} eliminada (vacía)`);
      return;
    }

    // Ajustar host e índice HDP si es necesario
    if (room.hostId === socket.id) room.hostId = room.players[0].id;
    if (room.hdpIndex >= room.players.length) room.hdpIndex = 0;

    // Si alguien se va durante 'choosing' y ahora todos los que quedan ya enviaron
    if (room.phase === 'choosing') {
      const hdp = room.players[room.hdpIndex];
      const nonHdpPlayers = room.players.filter(p => p.id !== hdp.id);
      const validSubmissions = Object.entries(room.submissions).filter(
        ([pid]) => room.players.some(p => p.id === pid)
      );

      if (nonHdpPlayers.length > 0 && validSubmissions.length >= nonHdpPlayers.filter(p => !p.isSpectator).length) {
        room.shuffledSubmissions = shuffle(
          validSubmissions.map(([playerId, submCards]) => ({
            playerId,
            cards: Array.isArray(submCards) ? submCards : [submCards],
          }))
        );
        room.phase = 'voting';
        io.to(roomCode).emit('room_updated', publicRoom(room));
        io.to(hdp.id).emit('voting_submissions', {
          submissions: room.shuffledSubmissions.map(s => s.cards.map(c => c.texto)),
        });
      } else {
        io.to(roomCode).emit('room_updated', publicRoom(room));
      }
    } else {
      io.to(roomCode).emit('room_updated', publicRoom(room));
    }

    if (leaving) {
      io.to(roomCode).emit('player_left', { playerName: leaving.name });
    }
    console.log(`🔌 ${socket.data.playerName} desconectado de sala ${roomCode}`);
  });
});

// ─── Health check ──────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ status: 'HDP Server OK 🃏', rooms: Object.keys(rooms).length }));

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => console.log(`\n🚀 Servidor HDP en http://localhost:${PORT}\n`));
