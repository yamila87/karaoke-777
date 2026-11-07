// Karaoke 777 Client App
(function () {
  let socket = null;
  let currentRoom = null;
  let myPlayer = null;
  let lastJoinPayload = null;
  let isTvMode = false;
  let selectedAvatar = '🎤';
  let activeAdminSection = 'genres';
  let currentRating = 5;
  let currentBadge = 'Voz de Oro 🌟';

  function getOrCreateSessionId() {
    try {
      let sid = sessionStorage.getItem('karaoke_session_id');
      if (!sid) {
        sid = `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        sessionStorage.setItem('karaoke_session_id', sid);
      }
      return sid;
    } catch (e) {
      return `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }
  }

  const sessionId = getOrCreateSessionId();

  // DOM Elements Cache
  const screens = {
    lobby: document.getElementById('screen-lobby'),
    game: document.getElementById('screen-game')
  };

  const stages = {
    selection: document.getElementById('stage-selection'),
    performance: document.getElementById('stage-performance')
  };

  const modals = {
    voting: document.getElementById('voting-modal'),
    results: document.getElementById('results-modal'),
    admin: document.getElementById('admin-modal')
  };

  // Toast Helper
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  // Initialize Socket.io Connection
  function initSocket() {
    if (socket) {
      socket.disconnect();
    }
    socket = io();

    socket.on('connect', () => {
      console.log('Connected to server with socket id:', socket.id);
      if (lastJoinPayload) {
        socket.emit('join_room', lastJoinPayload);
      }
    });

    socket.on('joined_successfully', ({ player, roomCode, isHost, networkUrl }) => {
      myPlayer = player;
      showScreen('game');
      if (currentRoom) {
        renderRoomState(currentRoom);
      }

      // Update QR Code
      updateQrCode(networkUrl, roomCode);
    });

    socket.on('room_state', (roomData) => {
      currentRoom = roomData;
      renderRoomState(roomData);
    });

    socket.on('jackpot_spinning', ({ targets, held, durations }) => {
      setJackpotPhase('SPINNING');
      window.slotMachine.spinTo(targets, held, durations);
    });

    socket.on('jackpot_stopped', () => {
      setJackpotPhase('RESULT');
    });

    socket.on('reels_held_update', ({ held }) => {
      window.slotMachine.setHeldStates(held);
    });

    socket.on('timer_tick', ({ remaining, total }) => {
      updateTimers(remaining, total);
    });

    socket.on('floating_reaction', ({ emoji, text, senderName }) => {
      spawnFloatingReaction(emoji, text, senderName);
    });

    socket.on('round_results', (data) => {
      showRoundResults(data);
    });

    socket.on('prompts_updated', (prompts) => {
      if (currentRoom) {
        currentRoom.prompts = prompts;
        window.slotMachine.init(prompts);
        renderAdminItems();
      }
    });

    socket.on('toast_info', (msg) => showToast(msg, 'info'));
    socket.on('toast_success', (msg) => showToast(msg, 'success'));
    socket.on('toast_error', (msg) => showToast(msg, 'error'));

    socket.on('tv_open_youtube', ({ url, query }) => {
      showToast(`🔴 Abriendo en YouTube: ${query}`, 'info');
      const win = window.open(url, 'karaoke_youtube');
      if (!win) {
        showToast('⚠️ Habilitá las ventanas emergentes (pop-ups) en el navegador de la TV para que YouTube se abra solo', 'error');
      }
    });

    socket.on('open_youtube_local', ({ url }) => {
      window.open(url, '_blank');
    });
  }

  // Screen Switcher
  function showScreen(name) {
    Object.keys(screens).forEach((key) => {
      screens[key].classList.toggle('active', key === name);
    });
  }

  // Update QR Code Display
  async function updateQrCode(networkUrl, roomCode) {
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const baseUrl = !isLocalhost ? window.location.origin : (networkUrl || window.location.origin);
    const url = `${baseUrl}?room=${roomCode}`;
    try {
      const res = await fetch(`/api/qr?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      const qrImg = document.getElementById('qr-code-img');
      const networkLabel = document.getElementById('qr-network-url');
      const roomLabel = document.getElementById('qr-room-code');

      if (qrImg && data.qr) qrImg.src = data.qr;
      if (networkLabel) networkLabel.textContent = baseUrl;
      if (roomLabel) roomLabel.textContent = roomCode;
    } catch (e) {
      console.error('Failed to load QR:', e);
    }
  }

  // Render Full Room State
  function renderRoomState(room) {
    if (!room) return;

    // Check if slotMachine initialized
    if (!window.slotMachine.prompts && room.prompts) {
      window.slotMachine.init(room.prompts);
    }
    if (!window.slotMachine.isSpinning && room.phase !== 'SPINNING' && room.reels && room.reels.current) {
      window.slotMachine.setReelItems(room.reels.current);
    }
    window.slotMachine.setHeldStates(room.reels.held);

    // Sync myPlayer with room.players in case socket reconnected
    if (!isTvMode && myPlayer && Array.isArray(room.players)) {
      const synced = room.players.find(
        p =>
          p.id === myPlayer.id ||
          (p.name && myPlayer.name && p.name.trim().toLowerCase() === myPlayer.name.trim().toLowerCase())
      );
      if (synced) {
        myPlayer = synced;
      }
    }

    // Active Singer
    const activePlayer = room.players[room.currentTurnIndex] || null;
    const isMyTurn =
      !isTvMode &&
      myPlayer &&
      activePlayer &&
      (activePlayer.id === myPlayer.id ||
        (activePlayer.name && myPlayer.name && activePlayer.name.trim().toLowerCase() === myPlayer.name.trim().toLowerCase()));
    const connectedPlayers = room.players.filter(p => p.connected);
    const hasEnoughPlayers = connectedPlayers.length >= 2 || room.players.length >= 2;

    const singerNameEl = document.getElementById('current-singer-name');
    const singerAvatarEl = document.getElementById('current-singer-avatar');
    const singerStatusEl = document.getElementById('current-singer-status');

    if (!hasEnoughPlayers) {
      singerNameEl.textContent = activePlayer ? activePlayer.name : 'Esperando jugadores...';
      singerAvatarEl.textContent = activePlayer ? (activePlayer.avatar || '🎤') : '🎤';
      singerStatusEl.textContent = 'Se necesitan al menos 2 jugadores en la sala para empezar';
    } else if (activePlayer) {
      singerNameEl.textContent = activePlayer.name;
      singerAvatarEl.textContent = activePlayer.avatar || '🎤';
      singerStatusEl.textContent = isMyTurn
        ? '¡Es TU turno de brillar! Presioná el botón en tu pantalla'
        : `Turno de ${activePlayer.name} desde su celular`;
    } else {
      singerNameEl.textContent = 'Esperando a los cantantes...';
      singerAvatarEl.textContent = '🎤';
      singerStatusEl.textContent = 'Unite desde tu celular para comenzar';
    }

    // Phase Badge
    const phaseBadge = document.getElementById('game-phase-badge');
    const rerollIndicator = document.getElementById('reroll-indicator');
    if (rerollIndicator) {
      rerollIndicator.style.display = 'none';
    }

    const btnSpin = document.getElementById('btn-spin');
    const btnAccept = document.getElementById('btn-accept-spin');

    // Controls enablement: ONLY the active player on their phone can press action buttons (TV only projects)
    const canControl = isMyTurn;
    btnSpin.disabled = !canControl || room.phase === 'SPINNING' || room.hasSpunThisTurn;
    btnSpin.style.display = !isTvMode && (room.phase === 'LOBBY' || room.phase === 'SPINNING') ? 'inline-flex' : 'none';

    // Hold buttons hidden (no re-spins)
    [0, 1, 2].forEach((i) => {
      const holdBtn = document.getElementById(`hold-btn-${i}`);
      if (holdBtn) {
        holdBtn.disabled = true;
        holdBtn.style.display = 'none';
      }
    });

    // Update phase visuals
    if (room.phase === 'LOBBY') {
      if (!hasEnoughPlayers) {
        phaseBadge.textContent = `⏳ ESPERANDO JUGADORES (${connectedPlayers.length}/2)`;
      } else {
        phaseBadge.textContent = isMyTurn
          ? '🎰 ¡TU TURNO DE GIRAR!'
          : `🎰 ESPERANDO GIRO DE ${activePlayer ? activePlayer.name.toUpperCase() : 'JUGADOR'}`;
      }
      btnAccept.style.display = 'none';
      stages.selection.style.display = 'none';
      stages.performance.style.display = 'none';
      modals.voting.style.display = 'none';
      modals.results.style.display = 'none';
    } else if (room.phase === 'SPINNING') {
      phaseBadge.textContent = '🌀 GIRANDO EL JACKPOT...';
      btnAccept.style.display = 'none';
      stages.selection.style.display = 'none';
      stages.performance.style.display = 'none';
    } else if (room.phase === 'RESULT') {
      phaseBadge.textContent = isMyTurn ? '🎯 ¡ACEPTÁ TU DESAFÍO!' : '🎯 PREMISAS ASIGNADAS';
      btnAccept.style.display = canControl ? 'inline-flex' : 'none';
      stages.selection.style.display = 'none';
      stages.performance.style.display = 'none';
      modals.voting.style.display = 'none';
      modals.results.style.display = 'none';
    } else if (room.phase === 'SELECTION') {
      phaseBadge.textContent = '⏱️ ELIGIENDO CANCIÓN';
      btnAccept.style.display = 'none';
      stages.selection.style.display = 'flex';
      stages.performance.style.display = 'none';
      modals.voting.style.display = 'none';
      modals.results.style.display = 'none';

      // Fill premises recap
      if (room.reels.current[0]) {
        document.getElementById('recap-genre-icon').textContent = room.reels.current[0].icon;
        document.getElementById('recap-genre-name').textContent = room.reels.current[0].name;
      }
      if (room.reels.current[1]) {
        document.getElementById('recap-cat-icon').textContent = room.reels.current[1].icon;
        document.getElementById('recap-cat-name').textContent = room.reels.current[1].name;
      }
      if (room.reels.current[2]) {
        document.getElementById('recap-misc-icon').textContent = room.reels.current[2].icon;
        document.getElementById('recap-misc-name').textContent = room.reels.current[2].name;
      }

      // Check if duo/trio (randomly assigned by server)
      const misc = room.reels.current[2];
      const miscNorm = misc && misc.name
        ? misc.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        : '';
      const isTrio = misc && (miscNorm.includes('trio') || misc.id === 'm2');
      const isDuo = misc && (miscNorm.includes('duo') || misc.id === 'm1');
      const partnerGroup = document.getElementById('partner-select-group');
      const partnerLabel = document.getElementById('partner-group-label');
      const partnerDisplay = document.getElementById('random-partners-display');

      if (partnerGroup && partnerDisplay) {
        if (isDuo || isTrio) {
          partnerGroup.style.display = 'flex';
          if (partnerLabel) {
            partnerLabel.textContent = isTrio
              ? '🎲 Compañeros/as de Trío elegidos al azar:'
              : '🎲 Compañero/a de Dúo elegido/a al azar:';
          }
          const partnerIds =
            room.currentSong && Array.isArray(room.currentSong.partnerIds) && room.currentSong.partnerIds.length > 0
              ? room.currentSong.partnerIds
              : room.currentSong && room.currentSong.partnerId
              ? [room.currentSong.partnerId]
              : [];

          const partnerPlayers = partnerIds
            .map(id => room.players.find(p => p.id === id))
            .filter(Boolean);

          if (partnerPlayers.length > 0) {
            partnerDisplay.innerHTML = partnerPlayers
              .map(p => `<span>${p.avatar || '🎤'} ${p.name}</span>`)
              .join(' <span style="color: var(--text-muted);">&amp;</span> ');
          } else {
            partnerDisplay.textContent = '⚠️ Se necesitan más jugadores en la sala para sortear acompañantes';
          }
        } else {
          partnerGroup.style.display = 'none';
        }
      }

      // Show song input controls ONLY to the active singer on their phone
      const singerSelectionControls = document.getElementById('singer-selection-controls');
      if (singerSelectionControls) {
        singerSelectionControls.style.display = canControl ? 'flex' : 'none';
      }
      const spectatorSelectionMsg = document.getElementById('spectator-selection-msg');
      if (spectatorSelectionMsg) {
        spectatorSelectionMsg.style.display = canControl ? 'none' : 'block';
        spectatorSelectionMsg.textContent = `⏳ ${activePlayer ? activePlayer.name : 'El cantante'} está eligiendo qué canción cantar...`;
      }
      const btnConfirmSong = document.getElementById('btn-confirm-song');
      if (btnConfirmSong) {
        btnConfirmSong.disabled = !canControl;
      }
    } else if (room.phase === 'PERFORMING' || room.phase === 'VOTING') {
      const isVotingPhase = room.phase === 'VOTING';
      phaseBadge.textContent = isVotingPhase ? '⭐ VOTACIÓN EN CURSO' : '🎤 ¡EN EL ESCENARIO!';
      btnAccept.style.display = 'none';
      stages.selection.style.display = 'none';
      stages.performance.style.display = 'flex';
      modals.results.style.display = 'none';

      const perfTitle = document.getElementById('stage-performance-title');
      if (perfTitle) {
        perfTitle.innerHTML = isVotingPhase
          ? '<span>⭐</span> ¡VOTACIÓN EN CURSO!'
          : '<span>🔥</span> ¡EN EL ESCENARIO!';
      }

      document.getElementById('live-song-title').textContent = room.currentSong.title || 'Canción Sorpresa';
      document.getElementById('live-song-artist').textContent = room.currentSong.artist || 'Artista';

      const btnLiveYoutube = document.getElementById('btn-live-youtube');
      if (btnLiveYoutube) {
        const ytQuery = `${room.currentSong.title || ''} ${room.currentSong.artist || ''} karaoke`.trim();
        btnLiveYoutube.href =
          room.currentSong.youtubeUrl ||
          `https://www.youtube.com/results?search_query=${encodeURIComponent(ytQuery)}`;
      }

      let singersText = activePlayer ? activePlayer.name : 'Cantante';
      const partnerIds =
        room.currentSong && Array.isArray(room.currentSong.partnerIds) && room.currentSong.partnerIds.length > 0
          ? room.currentSong.partnerIds
          : room.currentSong && room.currentSong.partnerId
          ? [room.currentSong.partnerId]
          : [];
      const partnerNames = partnerIds
        .map(id => room.players.find(p => p.id === id))
        .filter(Boolean)
        .map(p => p.name);
      if (partnerNames.length > 0) {
        singersText += ` & ${partnerNames.join(' & ')}`;
      }
      document.getElementById('live-singers-names').textContent = singersText;

      const btnFinishSong = document.getElementById('btn-finish-song');
      if (btnFinishSong) {
        btnFinishSong.disabled = !canControl || isVotingPhase;
        btnFinishSong.style.display = (canControl && !isVotingPhase) ? 'inline-flex' : 'none';
      }

      const spectatorPerfMsg = document.getElementById('spectator-performance-msg');
      if (spectatorPerfMsg) {
        if (isVotingPhase) {
          spectatorPerfMsg.style.display = 'block';
          spectatorPerfMsg.textContent = isMyTurn
            ? '⏳ ¡La sala está votando tu performance en este momento!'
            : '⏳ Esperando a que todos los jugadores envíen su voto...';
        } else if (!canControl) {
          spectatorPerfMsg.style.display = 'block';
          spectatorPerfMsg.textContent = `🎧 Escuchando a ${singersText}... ¡Al terminar se abrirá la votación en tu celular!`;
        } else {
          spectatorPerfMsg.style.display = 'none';
        }
      }

      if (isVotingPhase) {
        const alreadyVoted = myPlayer && room.votes && room.votes[myPlayer.id];
        if (!isMyTurn && !isTvMode && !alreadyVoted) {
          modals.voting.style.display = 'flex';
          const promptSinger = activePlayer ? activePlayer.name : 'el cantante';
          document.getElementById('voting-singer-prompt').textContent = `¿Cómo cantó ${promptSinger}?`;
        } else {
          modals.voting.style.display = 'none';
        }
      } else {
        modals.voting.style.display = 'none';
      }
    } else if (room.phase === 'ROUND_OVER') {
      phaseBadge.textContent = '🏆 RONDA TERMINADA';
      stages.performance.style.display = 'none';
      modals.voting.style.display = 'none';
      modals.results.style.display = 'flex';
      const btnNextTurn = document.getElementById('btn-next-turn');
      if (btnNextTurn) {
        btnNextTurn.style.display = isTvMode ? 'none' : 'inline-flex';
      }
    }

    // Render Scoreboard
    renderScoreboard(room.players, room.currentTurnIndex);
  }

  // Render Scoreboard
  function renderScoreboard(players, currentTurnIndex) {
    const list = document.getElementById('scoreboard-list');
    const badge = document.getElementById('player-count-badge');
    if (!list) return;

    badge.textContent = `${players.length} jugador${players.length === 1 ? '' : 'es'}`;
    list.innerHTML = '';

    // Sort by score descending
    const sorted = [...players].sort((a, b) => b.score - a.score);

    sorted.forEach((p) => {
      const isTurn = players[currentTurnIndex] && players[currentTurnIndex].id === p.id;
      const row = document.createElement('div');
      row.className = `player-item ${isTurn ? 'is-current-turn' : ''}`;
      row.innerHTML = `
        <div class="player-meta">
          <span class="player-avatar">${p.avatar || '🎤'}</span>
          <div>
            <div class="player-name">${p.name} ${isTurn ? '👑' : ''}</div>
            <small style="color: var(--text-muted); font-size: 0.75rem;">${p.songsSung || 0} canciones</small>
          </div>
        </div>
        <div class="player-score">${p.score} pts</div>
      `;
      list.appendChild(row);
    });
  }

  // Update Timers
  function updateTimers(remaining, total) {
    const secEl = document.getElementById('selection-seconds');
    const selTimer = document.getElementById('selection-timer');
    if (secEl) {
      secEl.textContent = remaining;
      if (selTimer) {
        selTimer.classList.toggle('urgent', remaining <= 10);
      }
    }

    const voteTimer = document.getElementById('voting-timer');
    if (voteTimer) {
      voteTimer.textContent = `⏳ ${remaining}s`;
      voteTimer.classList.toggle('urgent', remaining <= 5);
    }

    if (remaining <= 3 && remaining > 0 && window.soundManager) {
      window.soundManager.playBeep(false);
    } else if (remaining === 0 && window.soundManager) {
      window.soundManager.playBeep(true);
    }
  }

  // Set Jackpot Local Phase helper
  function setJackpotPhase(phase) {
    const btnSpin = document.getElementById('btn-spin');
    if (btnSpin) {
      btnSpin.disabled = phase === 'SPINNING' || phase === 'RESULT';
      if (phase === 'RESULT') {
        btnSpin.style.display = 'none';
      }
    }
  }

  // Spawn Floating Reaction Particles
  function spawnFloatingReaction(emoji, text, senderName) {
    const particle = document.createElement('div');
    particle.className = 'floating-particle';
    particle.innerHTML = `
      <span>${emoji}</span>
      <span class="particle-sender">${senderName}</span>
    `;

    // Random horizontal position near center
    const randomLeft = 20 + Math.random() * 60;
    particle.style.left = `${randomLeft}vw`;

    document.body.appendChild(particle);

    if (window.soundManager) {
      window.soundManager.playReaction(emoji === '👏' ? 'applause' : emoji === '🍅' ? 'tomato' : 'fire');
    }

    setTimeout(() => {
      particle.remove();
    }, 2800);
  }

  // Show Round Results Modal
  function showRoundResults(data) {
    const pointsEl = document.getElementById('result-points-earned');
    const singerEl = document.getElementById('result-singer-name');
    const detailsEl = document.getElementById('result-details');

    if (pointsEl) pointsEl.textContent = `+${data.pointsEarned} pts`;
    if (singerEl) singerEl.textContent = `¡Excelente, ${data.singer ? data.singer.name : 'cantante'}!`;
    if (detailsEl) detailsEl.textContent = `Puntuación promedio: ${data.avgScore} ★ (${data.votes.length} votos)`;

    modals.results.style.display = 'flex';

    if (window.confetti) {
      window.confetti.burst(120);
    }
  }

  // Admin Items List Render
  function renderAdminItems() {
    const list = document.getElementById('admin-items-list');
    if (!list || !currentRoom || !currentRoom.prompts) return;

    const items = currentRoom.prompts[activeAdminSection] || [];
    list.innerHTML = '';

    items.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'admin-item-row';
      row.innerHTML = `
        <div class="admin-item-title">
          <span>${item.icon || '🎵'}</span>
          <span>${item.name}</span>
          <small style="color: var(--text-muted); font-size: 0.8rem;">(${item.hint || ''})</small>
        </div>
        <button class="btn-delete-sm" data-index="${index}">Eliminar</button>
      `;
      list.appendChild(row);
    });

    // Delete buttons
    list.querySelectorAll('.btn-delete-sm').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.index, 10);
        const currentList = [...(currentRoom.prompts[activeAdminSection] || [])];
        currentList.splice(idx, 1);
        socket.emit('admin_update_prompts', {
          section: activeAdminSection,
          items: currentList
        });
      });
    });
  }

  // Setup UI Event Listeners
  function setupEvents() {
    // Avatar selection
    document.querySelectorAll('.avatar-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.avatar-btn').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedAvatar = btn.dataset.avatar;
      });
    });

    // Join room button (as a player on phone)
    document.getElementById('btn-join-room').addEventListener('click', () => {
      isTvMode = false;
      document.body.classList.remove('mode-tv');
      document.getElementById('mode-icon').textContent = '📺';
      document.getElementById('mode-text').textContent = 'Modo TV';

      const name = document.getElementById('input-player-name').value.trim();
      const code = document.getElementById('input-room-code').value.trim() || '777';

      lastJoinPayload = {
        roomCode: code,
        name: name,
        avatar: selectedAvatar,
        isHost: false,
        sessionId: sessionId
      };

      initSocket();
    });

    function enterTvProjectionMode() {
      isTvMode = true;
      document.body.classList.add('mode-tv');
      document.getElementById('mode-icon').textContent = '📱';
      document.getElementById('mode-text').textContent = 'Modo Celu';

      const code = document.getElementById('input-room-code').value.trim() || '777';
      lastJoinPayload = {
        roomCode: code,
        name: 'Pantalla TV',
        avatar: '📺',
        isHost: true,
        sessionId: `tv_${sessionId}`
      };
      initSocket();
    }

    const btnJoinTv = document.getElementById('btn-join-tv');
    if (btnJoinTv) {
      btnJoinTv.addEventListener('click', enterTvProjectionMode);
    }

    // TV Mode Toggle
    document.getElementById('btn-mode-toggle').addEventListener('click', () => {
      if (!isTvMode) {
        enterTvProjectionMode();
      } else {
        isTvMode = false;
        lastJoinPayload = null;
        if (socket) {
          socket.disconnect();
          socket = null;
        }
        document.body.classList.remove('mode-tv');
        document.getElementById('mode-icon').textContent = '📺';
        document.getElementById('mode-text').textContent = 'Modo TV';
        showScreen('lobby');
      }
    });

    // Sound Toggle
    document.getElementById('btn-sound-toggle').addEventListener('click', () => {
      const isMuted = window.soundManager.toggleMute();
      document.getElementById('sound-icon').textContent = isMuted ? '🔇' : '🔊';
      showToast(isMuted ? 'Sonido silenciado' : 'Sonido activado');
    });

    // Spin Jackpot button
    document.getElementById('btn-spin').addEventListener('click', () => {
      if (!socket) return;
      socket.emit('spin_jackpot');
    });

    // Accept premises button
    document.getElementById('btn-accept-spin').addEventListener('click', () => {
      if (!socket) return;
      socket.emit('accept_premises');
    });

    // Hold Buttons (0, 1, 2)
    [0, 1, 2].forEach((i) => {
      const btn = document.getElementById(`hold-btn-${i}`);
      if (btn) {
        btn.addEventListener('click', () => {
          if (!socket) return;
          socket.emit('toggle_hold', { reelIndex: i });
        });
      }
    });

    // YouTube Karaoke Search Link
    const titleInput = document.getElementById('input-song-title');
    const artistInput = document.getElementById('input-song-artist');
    const ytLink = document.getElementById('link-youtube-search');

    function getYoutubeQuery() {
      const custom = `${titleInput.value} ${artistInput.value}`.trim();
      if (custom) return `${custom} karaoke`;
      const genreName =
        currentRoom && currentRoom.reels && currentRoom.reels.current && currentRoom.reels.current[0]
          ? currentRoom.reels.current[0].name
          : '';
      return genreName ? `${genreName} karaoke` : 'karaoke';
    }

    function updateYoutubeLink() {
      const query = getYoutubeQuery();
      ytLink.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    }
    titleInput.addEventListener('input', updateYoutubeLink);
    artistInput.addEventListener('input', updateYoutubeLink);

    if (ytLink) {
      ytLink.addEventListener('click', (e) => {
        const query = getYoutubeQuery();
        ytLink.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        if (socket && currentRoom && currentRoom.hasTv) {
          e.preventDefault();
          socket.emit('open_youtube_tv', { query });
        }
      });
    }

    // Confirm song / start singing
    document.getElementById('btn-confirm-song').addEventListener('click', () => {
      if (!socket) return;
      const title = titleInput.value.trim() || 'Canción Sorpresa';
      const artist = artistInput.value.trim();

      socket.emit('submit_song', { title, artist });
    });

    // Finish song button
    document.getElementById('btn-finish-song').addEventListener('click', () => {
      if (!socket) return;
      socket.emit('finish_performance');
    });

    // Voting Stars Selection
    const starBtns = document.querySelectorAll('#voting-stars-group .star-btn');
    starBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        currentRating = parseInt(btn.dataset.rating, 10);
        starBtns.forEach((b) => {
          const r = parseInt(b.dataset.rating, 10);
          b.classList.toggle('active', r <= currentRating);
        });
      });
    });

    // Voting Badge Selection
    const badgeTags = document.querySelectorAll('#voting-badges-group .badge-tag');
    badgeTags.forEach((tag) => {
      tag.addEventListener('click', () => {
        badgeTags.forEach((t) => t.classList.remove('selected'));
        tag.classList.add('selected');
        currentBadge = tag.dataset.badge;
      });
    });

    // Submit Vote
    document.getElementById('btn-submit-vote').addEventListener('click', () => {
      if (!socket) return;
      socket.emit('submit_vote', {
        rating: currentRating,
        badge: currentBadge
      });
      modals.voting.style.display = 'none';
      showToast('¡Voto registrado con éxito!', 'success');
    });

    // Next Turn Button
    document.getElementById('btn-next-turn').addEventListener('click', () => {
      if (!socket) return;
      modals.results.style.display = 'none';
      titleInput.value = '';
      artistInput.value = '';
      socket.emit('next_turn');
    });

    // Floating Reaction Buttons
    document.querySelectorAll('.reaction-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!socket) return;
        const emoji = btn.dataset.reaction;
        socket.emit('send_reaction', { emoji });
      });
    });

    // Admin Modal Open & Close
    document.getElementById('btn-admin-modal').addEventListener('click', () => {
      modals.admin.style.display = 'flex';
      renderAdminItems();
    });
    document.getElementById('btn-close-admin').addEventListener('click', () => {
      modals.admin.style.display = 'none';
    });
    document.getElementById('btn-admin-save-close').addEventListener('click', () => {
      modals.admin.style.display = 'none';
    });

    // Admin Tabs
    document.querySelectorAll('.admin-tab-btn').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.admin-tab-btn').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        activeAdminSection = tab.dataset.section;
        renderAdminItems();
      });
    });

    // Admin Add Item
    document.getElementById('btn-admin-add-item').addEventListener('click', () => {
      const icon = document.getElementById('admin-new-icon').value.trim() || '🎵';
      const name = document.getElementById('admin-new-name').value.trim();
      const hint = document.getElementById('admin-new-hint').value.trim();

      if (!name) {
        showToast('Ingresá un nombre para el ítem', 'error');
        return;
      }

      if (!currentRoom || !currentRoom.prompts) return;

      const currentList = [...(currentRoom.prompts[activeAdminSection] || [])];
      currentList.push({
        id: `${activeAdminSection[0]}_${Date.now()}`,
        name,
        icon,
        hint,
        color: '#ff007f'
      });

      socket.emit('admin_update_prompts', {
        section: activeAdminSection,
        items: currentList
      });

      document.getElementById('admin-new-name').value = '';
      document.getElementById('admin-new-hint').value = '';
    });

    // Admin Reset to Defaults
    document.getElementById('btn-admin-reset-default').addEventListener('click', () => {
      if (confirm('¿Restaurar todas las listas de géneros, categorías y retos a los valores originales?')) {
        socket.emit('admin_reset_prompts');
      }
    });

    // Auto-detect room from URL query parameter ?room=XYZ
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    if (roomParam) {
      document.getElementById('input-room-code').value = roomParam.toUpperCase();
    }
  }

  // Bootstrap when DOM ready
  document.addEventListener('DOMContentLoaded', () => {
    setupEvents();
  });
})();
