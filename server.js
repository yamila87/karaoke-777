const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const fs = require('fs');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

let PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;

// Load default prompts
const defaultPromptsPath = path.join(__dirname, 'data', 'default_prompts.json');
const customPromptsPath = path.join(__dirname, 'data', 'custom_prompts.json');

function loadPrompts() {
  try {
    if (fs.existsSync(customPromptsPath)) {
      return JSON.parse(fs.readFileSync(customPromptsPath, 'utf8'));
    }
    return JSON.parse(fs.readFileSync(defaultPromptsPath, 'utf8'));
  } catch (err) {
    console.error('Error loading prompts, using default fallback:', err);
    return JSON.parse(fs.readFileSync(defaultPromptsPath, 'utf8'));
  }
}

function saveCustomPrompts(prompts) {
  try {
    fs.writeFileSync(customPromptsPath, JSON.stringify(prompts, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving custom prompts:', err);
    return false;
  }
}

// Find local IPv4 address (prioritize Wi-Fi and ignore VirtualBox/WSL virtual adapters)
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const isVirtual =
          name.toLowerCase().includes('vethernet') ||
          name.toLowerCase().includes('wsl') ||
          name.toLowerCase().includes('virtual') ||
          (iface.mac && iface.mac.toLowerCase().startsWith('0a:00:27')) ||
          iface.address === '192.168.56.1';
        const isWifi = name.toLowerCase().includes('wi-fi') || name.toLowerCase().includes('wlan');
        candidates.push({ address: iface.address, isVirtual, isWifi });
      }
    }
  }

  const wifi = candidates.find(c => c.isWifi && !c.isVirtual);
  if (wifi) return wifi.address;

  const nonVirtual = candidates.find(c => !c.isVirtual);
  if (nonVirtual) return nonVirtual.address;

  return candidates[0] ? candidates[0].address : 'localhost';
}

const localIp = getLocalIpAddress();
const getPublicBaseUrl = () => process.env.RENDER_EXTERNAL_URL || `http://${localIp}:${PORT}`;

app.use(express.json());
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    }
  })
);

// QR code API endpoint
app.get('/api/qr', async (req, res) => {
  const url = req.query.url || getPublicBaseUrl();
  try {
    const qrDataUrl = await QRCode.toDataURL(url, {
      margin: 1,
      color: {
        dark: '#000000',
        light: '#ffffff'
      },
      width: 260
    });
    res.json({ qr: qrDataUrl, url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR' });
  }
});

// Network info API
app.get('/api/network-info', (req, res) => {
  res.json({
    ip: localIp,
    port: PORT,
    localUrl: `http://localhost:${PORT}`,
    networkUrl: getPublicBaseUrl()
  });
});

// Rooms state in memory
const rooms = new Map();

function createNewRoom(roomCode) {
  const prompts = loadPrompts();
  const getRandomItem = (arr) => arr[Math.floor(Math.random() * arr.length)];

  return {
    code: roomCode,
    hostSocketId: null,
    players: [], // { id, name, avatar, score, songsSung, connected }
    currentTurnIndex: 0,
    phase: 'LOBBY', // 'LOBBY' | 'SPINNING' | 'RESULT' | 'SELECTION' | 'PERFORMING' | 'VOTING' | 'ROUND_OVER'
    hasSpunThisTurn: false,
    reels: {
      current: [
        getRandomItem(prompts.genres),
        getRandomItem(prompts.categories),
        getRandomItem(prompts.miscellaneous)
      ],
      held: [false, false, false],
      rerollsLeft: 0
    },
    currentSong: {
      title: '',
      artist: '',
      partnerId: null,
      partnerIds: []
    },
    timer: {
      total: 60,
      remaining: 60,
      intervalId: null
    },
    votes: {}, // [voterId]: { score: 1-5, badges: [] }
    prompts: prompts,
    history: []
  };
}

function getPartnerCountForMisc(miscItem) {
  if (!miscItem || !miscItem.name) return 0;
  const normalized = miscItem.name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (normalized.includes('trio') || miscItem.id === 'm2') return 2;
  if (normalized.includes('duo') || miscItem.id === 'm1') return 1;
  return 0;
}

function pickRandomPartners(room) {
  const activePlayer = room.players[room.currentTurnIndex];
  const misc = room.reels.current[2];
  const countNeeded = getPartnerCountForMisc(misc);
  if (countNeeded <= 0 || !activePlayer) {
    room.currentSong.partnerIds = [];
    room.currentSong.partnerId = null;
    return [];
  }

  let candidates = room.players.filter(p => p.id !== activePlayer.id && p.connected);
  if (candidates.length === 0) {
    candidates = room.players.filter(p => p.id !== activePlayer.id);
  }

  const shuffled = [...candidates];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const chosen = shuffled.slice(0, countNeeded).map(p => p.id);
  room.currentSong.partnerIds = chosen;
  room.currentSong.partnerId = chosen[0] || null;
  return chosen;
}

function getSafeRoomData(room) {
  const { timer, ...rest } = room;
  return {
    ...rest,
    hasTv: Boolean(room.hostSocketId),
    timer: {
      total: timer.total,
      remaining: timer.remaining,
      running: timer.intervalId !== null
    }
  };
}

function startRoomTimer(room, durationSec, onTick, onComplete) {
  if (room.timer.intervalId) {
    clearInterval(room.timer.intervalId);
  }
  room.timer.total = durationSec;
  room.timer.remaining = durationSec;

  room.timer.intervalId = setInterval(() => {
    room.timer.remaining -= 1;
    onTick(room.timer.remaining);
    if (room.timer.remaining <= 0) {
      clearInterval(room.timer.intervalId);
      room.timer.intervalId = null;
      if (onComplete) onComplete();
    }
  }, 1000);
}

function stopRoomTimer(room) {
  if (room.timer.intervalId) {
    clearInterval(room.timer.intervalId);
    room.timer.intervalId = null;
  }
}

// Socket.io handlers
io.on('connection', (socket) => {
  let currentRoomCode = null;
  let currentPlayerId = socket.id;

  // Join or create room
  socket.on('join_room', ({ roomCode = '777', name = '', avatar = '🎤', isHost = false, sessionId = null }) => {
    const code = roomCode.toUpperCase().trim() || '777';
    currentRoomCode = code;
    socket.join(code);

    if (!rooms.has(code)) {
      rooms.set(code, createNewRoom(code));
    }

    const room = rooms.get(code);
    const stableId = sessionId || socket.id;
    currentPlayerId = stableId;

    if (isHost) {
      room.hostSocketId = socket.id;
      room.players = room.players.filter(p => p.id !== stableId && p.socketId !== socket.id);
      if (room.currentTurnIndex >= room.players.length) {
        room.currentTurnIndex = 0;
      }

      const tvViewer = {
        id: stableId,
        socketId: socket.id,
        name: 'Pantalla TV',
        avatar: '📺',
        isHost: true
      };

      socket.emit('joined_successfully', {
        player: tvViewer,
        roomCode: code,
        isHost: true,
        networkUrl: getPublicBaseUrl()
      });
      io.to(code).emit('room_state', getSafeRoomData(room));

      console.log(`[${code}] TV Display (${socket.id}) connected. Players: ${room.players.length}`);
      return;
    }

    const trimmedName = (name || '').trim();

    // Find existing player by stable sessionId, or by socketId, or by explicit non-default name if disconnected
    let player = room.players.find(
      p =>
        p.id === stableId ||
        p.socketId === socket.id ||
        (trimmedName && !p.connected && p.name.trim().toLowerCase() === trimmedName.toLowerCase())
    );

    if (player) {
      const oldId = player.id;
      player.id = stableId;
      player.socketId = socket.id;
      if (trimmedName) {
        player.name = trimmedName;
      }
      player.avatar = avatar || player.avatar || '🎤';
      player.isHost = false;
      player.connected = true;

      if (oldId !== stableId) {
        if (room.currentSong && Array.isArray(room.currentSong.partnerIds)) {
          room.currentSong.partnerIds = room.currentSong.partnerIds.map(pid => (pid === oldId ? stableId : pid));
        }
        if (room.currentSong && room.currentSong.partnerId === oldId) {
          room.currentSong.partnerId = stableId;
        }
      }
    } else {
      const finalName = trimmedName || `Cantante ${room.players.length + 1}`;
      player = {
        id: stableId,
        socketId: socket.id,
        name: finalName,
        avatar: avatar || '🎤',
        score: 0,
        songsSung: 0,
        isHost: false,
        connected: true
      };
      room.players.push(player);
    }

    if (
      (room.phase === 'RESULT' || room.phase === 'SELECTION') &&
      getPartnerCountForMisc(room.reels.current[2]) >
        (room.currentSong.partnerIds ? room.currentSong.partnerIds.length : 0)
    ) {
      pickRandomPartners(room);
    }

    // Send joined_successfully BEFORE broadcasting room_state so client has myPlayer ready
    socket.emit('joined_successfully', {
      player,
      roomCode: code,
      isHost: false,
      networkUrl: getPublicBaseUrl()
    });
    io.to(code).emit('room_state', getSafeRoomData(room));

    console.log(`[${code}] Player "${player.name}" (session: ${player.id}, socket: ${socket.id}) connected. Total: ${room.players.length}`);
  });

  // Switch display mode (Host TV vs Player)
  socket.on('set_host_mode', ({ roomCode, isHost }) => {
    const code = roomCode || currentRoomCode;
    const room = rooms.get(code);
    if (!room) return;

    if (isHost) {
      room.hostSocketId = socket.id;
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.currentTurnIndex >= room.players.length) {
        room.currentTurnIndex = 0;
      }
    }
    io.to(code).emit('room_state', getSafeRoomData(room));
  });

  // Start game / Next Turn
  socket.on('start_game', () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    const connectedCount = room.players.filter(p => p.connected).length;
    if (connectedCount < 2) {
      socket.emit('toast_error', '¡Se necesitan al menos 2 jugadores en la sala para empezar la partida!');
      return;
    }

    room.phase = 'LOBBY';
    room.hasSpunThisTurn = false;
    room.reels.held = [false, false, false];
    room.reels.rerollsLeft = 0;
    room.votes = {};
    room.currentSong = { title: '', artist: '', partnerId: null, partnerIds: [] };
    stopRoomTimer(room);

    io.to(currentRoomCode).emit('room_state', getSafeRoomData(room));
  });

  // Next Turn (skip disconnected players if there are connected ones)
  socket.on('next_turn', () => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.players.length === 0) return;

    stopRoomTimer(room);
    const total = room.players.length;
    let nextIdx = (room.currentTurnIndex + 1) % total;
    for (let step = 0; step < total; step++) {
      const candidateIdx = (room.currentTurnIndex + 1 + step) % total;
      if (room.players[candidateIdx] && room.players[candidateIdx].connected) {
        nextIdx = candidateIdx;
        break;
      }
    }
    room.currentTurnIndex = nextIdx;
    room.phase = 'LOBBY';
    room.hasSpunThisTurn = false;
    room.reels.held = [false, false, false];
    room.reels.rerollsLeft = 0;
    room.votes = {};
    room.currentSong = { title: '', artist: '', partnerId: null, partnerIds: [] };

    io.to(currentRoomCode).emit('room_state', getSafeRoomData(room));
  });

  // Toggle Hold on a reel (disabled since there is only 1 spin per turn)
  socket.on('toggle_hold', () => {
    return;
  });

  // Spin jackpot (only 1 spin allowed per turn, min 2 players, only active player on their phone)
  socket.on('spin_jackpot', () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    const connectedCount = room.players.filter(p => p.connected).length;
    if (connectedCount < 2 && room.players.length < 2) {
      socket.emit('toast_error', '¡Se necesitan al menos 2 jugadores en la sala para empezar la partida!');
      return;
    }

    const activePlayer = room.players[room.currentTurnIndex];
    const isTurn =
      activePlayer &&
      (activePlayer.id === currentPlayerId || activePlayer.socketId === socket.id || activePlayer.id === socket.id);

    if (!isTurn) {
      socket.emit('toast_error', '¡Solo el jugador en turno puede girar el Jackpot desde su celular!');
      return;
    }

    if (room.hasSpunThisTurn || room.phase !== 'LOBBY') {
      socket.emit('toast_error', '¡Solo tenés un giro por turno!');
      return;
    }

    room.hasSpunThisTurn = true;
    room.reels.rerollsLeft = 0;
    room.reels.held = [false, false, false];

    spinJackpotInternal(room);
  });

  function spinJackpotInternal(room) {
    room.phase = 'SPINNING';
    stopRoomTimer(room);

    const prompts = room.prompts;
    const getRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

    const targets = [
      getRandom(prompts.genres),
      getRandom(prompts.categories),
      getRandom(prompts.miscellaneous)
    ];

    room.reels.current = targets;
    pickRandomPartners(room);

    // Notify all clients to start spin animation
    io.to(room.code).emit('jackpot_spinning', {
      targets: targets,
      held: [false, false, false],
      durations: [2200, 3000, 3800] // Staggered stops
    });

    // After animation finishes on all screens, change state to RESULT
    setTimeout(() => {
      if (room.phase === 'SPINNING') {
        room.phase = 'RESULT';
        io.to(room.code).emit('jackpot_stopped', {
          result: room.reels.current,
          rerollsLeft: 0
        });
        io.to(room.code).emit('room_state', getSafeRoomData(room));
      }
    }, 4000);
  }

  // Accept premises and move to song selection
  socket.on('accept_premises', () => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.phase !== 'RESULT') return;

    if (
      getPartnerCountForMisc(room.reels.current[2]) > 0 &&
      (!room.currentSong.partnerIds || room.currentSong.partnerIds.length === 0)
    ) {
      pickRandomPartners(room);
    }

    room.phase = 'SELECTION';
    // 60-second selection countdown
    startRoomTimer(room, 60, (remaining) => {
      io.to(room.code).emit('timer_tick', { remaining, total: 60 });
    }, () => {
      // Time is up! Move automatically to singing
      io.to(room.code).emit('toast_info', '¡Se acabó el tiempo para elegir! ¡A cantar con lo elegido!');
      room.phase = 'PERFORMING';
      io.to(room.code).emit('room_state', getSafeRoomData(room));
    });

    io.to(currentRoomCode).emit('room_state', getSafeRoomData(room));
  });

  // Singer submits song info
  socket.on('submit_song', ({ title, artist }) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    room.currentSong.title = title || 'Canción Sorpresa';
    room.currentSong.artist = artist || '';

    if (
      getPartnerCountForMisc(room.reels.current[2]) > 0 &&
      (!room.currentSong.partnerIds || room.currentSong.partnerIds.length === 0)
    ) {
      pickRandomPartners(room);
    }

    stopRoomTimer(room);
    room.phase = 'PERFORMING';

    const ytQuery = `${room.currentSong.title} ${room.currentSong.artist} karaoke`.trim();
    const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(ytQuery)}`;
    room.currentSong.youtubeUrl = ytUrl;

    io.to(currentRoomCode).emit('room_state', getSafeRoomData(room));
    io.to(currentRoomCode).emit('song_announced', room.currentSong);
  });

  // Open YouTube search on TV screen (or fallback to sender phone if no TV connected)
  socket.on('open_youtube_tv', ({ query }) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    const searchQuery =
      (query || `${room.currentSong.title || ''} ${room.currentSong.artist || ''} karaoke`).trim() || 'karaoke';
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery)}`;

    if (room.hostSocketId) {
      io.to(room.hostSocketId).emit('tv_open_youtube', { url, query: searchQuery });
      socket.emit('toast_success', '📺 ¡Se abrió la búsqueda de YouTube en la TV!');
    } else {
      socket.emit('open_youtube_local', { url });
    }
  });

  // Finish singing, open voting
  socket.on('finish_performance', () => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.phase !== 'PERFORMING') return;

    room.phase = 'VOTING';
    room.votes = {};

    // 40-second voting timer
    startRoomTimer(room, 40, (remaining) => {
      io.to(room.code).emit('timer_tick', { remaining, total: 40 });
    }, () => {
      // Automatic tally when time expires
      tallyVotes(room);
    });

    io.to(currentRoomCode).emit('room_state', getSafeRoomData(room));
  });

  // Player sends a vote for current performance
  socket.on('submit_vote', ({ rating, badge }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.phase !== 'VOTING') return;

    const singer = room.players[room.currentTurnIndex];
    const voter = room.players.find(p => p.id === currentPlayerId || p.socketId === socket.id || p.id === socket.id);
    const voterKey = voter ? voter.id : currentPlayerId || socket.id;

    if (singer && (singer.id === voterKey || singer.socketId === socket.id)) {
      socket.emit('toast_error', '¡No podés votarte a vos mismo!');
      return;
    }

    const numRating = Math.max(1, Math.min(5, parseInt(rating) || 5));
    room.votes[voterKey] = {
      voterId: voterKey,
      rating: numRating,
      badge: badge || '🎤'
    };

    const otherPlayers = room.players.filter(p => p.id !== (singer && singer.id));
    const connectedOtherPlayers = otherPlayers.filter(p => p.connected);
    const expectedVoters = connectedOtherPlayers.length > 0 ? connectedOtherPlayers.length : Math.max(1, otherPlayers.length);

    io.to(currentRoomCode).emit('vote_recorded', {
      count: Object.keys(room.votes).length,
      expected: expectedVoters
    });

    // Check if everyone has voted
    if (Object.keys(room.votes).length >= expectedVoters && expectedVoters > 0) {
      tallyVotes(room);
    }
  });

  function tallyVotes(room) {
    stopRoomTimer(room);
    room.phase = 'ROUND_OVER';

    const votesList = Object.values(room.votes);
    let avgScore = 5;
    if (votesList.length > 0) {
      const sum = votesList.reduce((acc, v) => acc + v.rating, 0);
      avgScore = Math.round((sum / votesList.length) * 10) / 10;
    }

    const pointsEarned = Math.round(avgScore * 20); // up to 100 points
    const singer = room.players[room.currentTurnIndex];
    if (singer) {
      singer.score += pointsEarned;
      singer.songsSung += 1;
    }

    // If duo/trio partners were chosen, reward them too!
    const partnerIds =
      room.currentSong.partnerIds && room.currentSong.partnerIds.length > 0
        ? room.currentSong.partnerIds
        : room.currentSong.partnerId
        ? [room.currentSong.partnerId]
        : [];

    partnerIds.forEach(pid => {
      const partner = room.players.find(p => p.id === pid);
      if (partner) {
        partner.score += Math.round(pointsEarned * 0.8);
      }
    });

    // Save history
    room.history.push({
      round: room.history.length + 1,
      singerName: singer ? singer.name : 'Anónimo',
      song: room.currentSong.title,
      artist: room.currentSong.artist,
      premises: [...room.reels.current],
      avgScore,
      pointsEarned,
      votesCount: votesList.length
    });

    io.to(room.code).emit('round_results', {
      singer: singer,
      avgScore,
      pointsEarned,
      votes: votesList,
      historyItem: room.history[room.history.length - 1]
    });

    io.to(room.code).emit('room_state', getSafeRoomData(room));
  }

  // Live floating reaction emojis
  socket.on('send_reaction', ({ emoji, text }) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    const sender = room.players.find(p => p.id === socket.id);
    io.to(currentRoomCode).emit('floating_reaction', {
      emoji: emoji || '🔥',
      text: text || '',
      senderName: sender ? sender.name : 'Fan'
    });
  });

  // Admin: Update prompts
  socket.on('admin_update_prompts', ({ section, items }) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    if (['genres', 'categories', 'miscellaneous'].includes(section) && Array.isArray(items)) {
      room.prompts[section] = items;
      saveCustomPrompts(room.prompts);
      io.to(currentRoomCode).emit('prompts_updated', room.prompts);
      socket.emit('toast_success', `¡Lista de ${section} actualizada correctamente!`);
    }
  });

  // Admin: Reset prompts to default
  socket.on('admin_reset_prompts', () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    try {
      const defaults = JSON.parse(fs.readFileSync(defaultPromptsPath, 'utf8'));
      room.prompts = defaults;
      if (fs.existsSync(customPromptsPath)) {
        fs.unlinkSync(customPromptsPath);
      }
      io.to(currentRoomCode).emit('prompts_updated', room.prompts);
      socket.emit('toast_success', '¡Listas restauradas a los valores por defecto!');
    } catch (err) {
      socket.emit('toast_error', 'Error al restaurar listas.');
    }
  });

  // Reset entire game / scores
  socket.on('admin_reset_game', () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    room.players.forEach(p => { p.score = 0; p.songsSung = 0; });
    room.currentTurnIndex = 0;
    room.history = [];
    room.phase = 'LOBBY';
    room.hasSpunThisTurn = false;
    room.currentSong = { title: '', artist: '', partnerId: null, partnerIds: [] };
    stopRoomTimer(room);

    io.to(currentRoomCode).emit('room_state', getSafeRoomData(room));
    io.to(currentRoomCode).emit('toast_info', '¡Partida reiniciada!');
  });

  // Disconnection handler
  socket.on('disconnect', () => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    const player = room.players.find(p => p.socketId === socket.id || p.id === socket.id);
    if (player && player.socketId === socket.id) {
      player.connected = false;
    }

    if (room.hostSocketId === socket.id) {
      room.hostSocketId = null;
    }

    io.to(currentRoomCode).emit('room_state', getSafeRoomData(room));
    console.log(`Socket ${socket.id} disconnected from room ${currentRoomCode}`);
  });
});

function startServer(portToTry) {
  server.listen(portToTry, '0.0.0.0', () => {
    PORT = portToTry;
    console.log('========================================================');
    console.log(`🎤 KARAOKE 777 JACKPOT SERVER INICIADO 🎰`);
    console.log(`- En esta máquina:   http://localhost:${PORT}`);
    console.log(`- Para celulares:    http://${localIp}:${PORT}`);
    console.log('========================================================');
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`⚠️ Puerto ${PORT} ocupado. Probando puerto ${PORT + 1}...`);
    PORT += 1;
    setTimeout(() => startServer(PORT), 250);
  } else {
    console.error('Error al iniciar servidor:', err);
  }
});

startServer(PORT);
