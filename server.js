const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 5000,
  cors: { origin: '*' }
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

const BOARD_SIZE = 15;
const TURN_TIME_LIMIT = 30;
const COMBO_WINDOW_MS = 8000; // 다중 플레이어 합심 콤보 감지 시간 (8초)
const rooms = new Map();

const CURSOR_COLORS = [
  '#ff3b5c', '#ff7eb3', '#b845ff', '#6366f1',
  '#00b4d8', '#06d6a0', '#ffd166', '#ff8500', '#38b000'
];

function createEmptyBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
}

// ==========================================
// 렌주룰(Renju Rules) 및 5목 승리 라인 검출 엔진
// ==========================================
const DIRECTIONS = [
  [0, 1], [1, 0], [1, 1], [1, -1]
];

function extractLine(board, row, col, dr, dc, color) {
  const line = [];
  for (let step = -6; step <= 6; step++) {
    if (step === 0) {
      line.push('B');
      continue;
    }
    const r = row + dr * step;
    const c = col + dc * step;
    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) {
      line.push('W');
    } else if (board[r][c] === null) {
      line.push('E');
    } else if (board[r][c] === color) {
      line.push('B');
    } else {
      line.push('W');
    }
  }
  return line;
}

function getWinningLine(board, row, col, color) {
  for (const [dr, dc] of DIRECTIONS) {
    const stones = [{ row, col }];

    let r = row + dr, c = col + dc;
    while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r][c] === color) {
      stones.push({ row: r, col: c });
      r += dr; c += dc;
    }

    r = row - dr; c = col - dc;
    while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r][c] === color) {
      stones.unshift({ row: r, col: c });
      r -= dr; c -= dc;
    }

    if (color === 'black' && stones.length === 5) return stones;
    if (color === 'white' && stones.length >= 5) return stones;
  }
  return null;
}

function isForbiddenForBlack(board, row, col) {
  if (board[row][col] !== null) return false;
  const lines = DIRECTIONS.map(([dr, dc]) => extractLine(board, row, col, dr, dc, 'black'));

  for (const line of lines) {
    let count = 1, l = 5, r = 7;
    while (l >= 0 && line[l] === 'B') { count++; l--; }
    while (r < 13 && line[r] === 'B') { count++; r++; }
    if (count === 5) return false;
  }

  for (const line of lines) {
    let count = 1, l = 5, r = 7;
    while (l >= 0 && line[l] === 'B') { count++; l--; }
    while (r < 13 && line[r] === 'B') { count++; r++; }
    if (count >= 6) return true;
  }

  let fourCount = 0;
  let openThreeCount = 0;

  for (const line of lines) {
    const fiveMakingPositions = [];
    for (let start = 2; start <= 6; start++) {
      let bCount = 0, ePos = -1;
      for (let i = start; i < start + 5; i++) {
        if (line[i] === 'B') bCount++;
        else if (line[i] === 'E') ePos = i;
      }
      if (bCount === 4 && ePos !== -1) {
        if (line[start - 1] !== 'B' && line[start + 5] !== 'B') {
          if (!fiveMakingPositions.includes(ePos)) fiveMakingPositions.push(ePos);
        }
      }
    }

    if (fiveMakingPositions.length === 1) {
      fourCount += 1;
    } else if (fiveMakingPositions.length >= 2) {
      const dist = Math.abs(fiveMakingPositions[0] - fiveMakingPositions[1]);
      fourCount += dist === 5 ? 1 : 2;
    }

    if (fiveMakingPositions.length === 0) {
      let hasOpenThree = false;
      for (let k = 3; k <= 9; k++) {
        if (line[k] !== 'E') continue;
        const temp = [...line];
        temp[k] = 'B';
        for (let s = 3; s <= 6; s++) {
          if (k < s || k > s + 3) continue;
          if (temp[s] === 'B' && temp[s + 1] === 'B' && temp[s + 2] === 'B' && temp[s + 3] === 'B') {
            if (temp[s - 1] === 'E' && temp[s + 4] === 'E' && temp[s - 2] !== 'B' && temp[s + 5] !== 'B') {
              hasOpenThree = true;
              break;
            }
          }
        }
        if (hasOpenThree) break;
      }
      if (hasOpenThree) openThreeCount += 1;
    }
  }

  return fourCount >= 2 || openThreeCount >= 2;
}

function getForbiddenMoves(board) {
  const list = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c] === null && isForbiddenForBlack(board, r, c)) {
        list.push({ row: r, col: c });
      }
    }
  }
  return list;
}

function getPublicRoomList() {
  const list = [];
  rooms.forEach((room) => {
    list.push({
      id: room.id,
      title: room.title,
      playerCount: room.players.length,
      spectatorCount: room.spectators.length,
      status: room.status
    });
  });
  return list;
}

function broadcastRoomList() {
  io.emit('roomList', getPublicRoomList());
}

function broadcastHeatmapToSpectators(room) {
  const counts = new Map();
  room.heatmapVotes.forEach(({ row, col }) => {
    const key = `${row},${col}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  const aggregated = [];
  counts.forEach((count, key) => {
    const [r, c] = key.split(',').map(Number);
    aggregated.push({ row: r, col: c, count });
  });

  room.spectators.forEach((spec) => {
    io.to(spec.id).emit('heatmapUpdate', aggregated);
  });
}

function clearPendingUndo(room) {
  if (room.pendingUndo) {
    room.pendingUndo = null;
    io.to(room.id).emit('undoCleared');
  }
}

function clearRoomTimers(room) {
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
}

function startTurnTimer(room) {
  clearRoomTimers(room);
  room.timeLeft = TURN_TIME_LIMIT;

  room.timer = setInterval(() => {
    room.timeLeft -= 1;
    io.to(room.id).emit('timerTick', { timeLeft: room.timeLeft, turn: room.turn });

    if (room.timeLeft <= 0) {
      clearRoomTimers(room);
      clearPendingUndo(room);
      room.status = 'finished';
      room.heatmapVotes.clear();
      broadcastHeatmapToSpectators(room);

      const winnerColor = room.turn === 'black' ? 'white' : 'black';
      const winner = room.players.find((p) => p.color === winnerColor);
      emitRoomState(room, {
        winner,
        reason: '⏰ 시간 초과! 아깝게 턴이 넘어갔네요.'
      });
      broadcastRoomList();
    }
  }, 1000);
}

function emitRoomState(room, extra = {}) {
  io.to(room.id).emit('updateState', {
    id: room.id,
    title: room.title,
    players: room.players,
    spectators: room.spectators,
    spectatorCount: room.spectators.length,
    board: room.board,
    history: room.history,
    turn: room.turn,
    status: room.status,
    lastMove: room.lastMove,
    winLine: room.winLine || null,
    timeLeft: room.timeLeft,
    forbiddenMoves: room.status === 'playing' ? getForbiddenMoves(room.board) : [],
    ...extra
  });
}

// ==========================================
// Socket.io 실시간 이벤트 핸들링
// ==========================================
io.on('connection', (socket) => {
  socket.emit('roomList', getPublicRoomList());

  socket.on('joinRoom', ({ roomId, title, nickname, playerName, asSpectator }) => {
    const cleanId = String(roomId || '').trim().slice(0, 20);
    const rawNick = nickname || playerName || '';
    const cleanNick = String(rawNick).trim().slice(0, 12);

    if (!cleanNick || cleanNick === 'undefined' || cleanNick === 'null') {
      socket.emit('joinError', '⚠️ 입장하기 전에 닉네임을 먼저 입력해주세요!');
      return;
    }
    if (!cleanId) return;

    let room = rooms.get(cleanId);
    if (!room) {
      room = {
        id: cleanId,
        title: String(title || `${cleanNick}님의 오목방`).trim().slice(0, 25),
        players: [],
        spectators: [],
        board: createEmptyBoard(),
        history: [],
        turn: 'black',
        status: 'waiting',
        lastMove: null,
        winLine: null,
        pendingUndo: null,
        timeLeft: TURN_TIME_LIMIT,
        timer: null,
        cursors: new Map(),
        heatmapVotes: new Map(),
        emoteComboLog: []
      };
      rooms.set(cleanId, room);
    }

    const usedColors = new Set(Array.from(room.cursors.values()).map((c) => c.cursorColor));
    const availableColors = CURSOR_COLORS.filter((c) => !usedColors.has(c));
    const pickedColor = availableColors.length > 0
      ? availableColors[Math.floor(Math.random() * availableColors.length)]
      : CURSOR_COLORS[Math.floor(Math.random() * CURSOR_COLORS.length)];

    socket.join(cleanId);
    socket.data.roomId = cleanId;
    socket.data.playerName = cleanNick;
    socket.data.cursorColor = pickedColor;

    if (asSpectator || room.players.length >= 2) {
      socket.data.role = 'spectator';
      socket.data.stoneColor = null;
      room.spectators.push({
        id: socket.id,
        nickname: cleanNick,
        playerName: cleanNick,
        cursorColor: pickedColor
      });
      socket.emit('joined', {
        id: socket.id,
        playerId: socket.id,
        nickname: cleanNick,
        playerName: cleanNick,
        role: 'spectator',
        color: null,
        roomId: cleanId,
        title: room.title,
        cursorColor: pickedColor
      });
      broadcastHeatmapToSpectators(room);
      io.to(cleanId).emit('chatMessage', {
        system: true,
        text: `👀 ${cleanNick}님이 구경하러 오셨습니다~`
      });
    } else {
      const existingColors = room.players.map((p) => p.color);
      const assignedColor = existingColors.includes('black') ? 'white' : 'black';
      socket.data.role = 'player';
      socket.data.stoneColor = assignedColor;
      room.players.push({
        id: socket.id,
        nickname: cleanNick,
        playerName: cleanNick,
        color: assignedColor,
        wins: 0,
        cursorColor: pickedColor
      });

      socket.emit('joined', {
        id: socket.id,
        playerId: socket.id,
        nickname: cleanNick,
        playerName: cleanNick,
        role: 'player',
        color: assignedColor,
        roomId: cleanId,
        title: room.title,
        cursorColor: pickedColor
      });

      io.to(cleanId).emit('chatMessage', {
        system: true,
        text: `🎮 ${cleanNick}님이 [${assignedColor === 'black' ? '흑돌' : '백돌'}] 자리에 앉았습니다!`
      });

      if (room.players.length === 2 && room.status === 'waiting') {
        room.status = 'playing';
        room.board = createEmptyBoard();
        room.history = [];
        room.turn = 'black';
        room.lastMove = null;
        room.winLine = null;
        room.pendingUndo = null;
        room.heatmapVotes.clear();
        startTurnTimer(room);
        io.to(cleanId).emit('chatMessage', {
          system: true,
          text: '🔥 대국 시작! 흑돌부터 먼저 두실게요~ (렌주룰 적용)'
        });
      }
    }

    const myCursorData = {
      id: socket.id,
      playerId: socket.id,
      nickname: cleanNick,
      playerName: cleanNick,
      role: socket.data.role,
      stoneColor: socket.data.stoneColor,
      cursorColor: socket.data.cursorColor,
      x: 0,
      y: 0,
      laser: false
    };
    room.cursors.set(socket.id, myCursorData);

    socket.emit('existingCursors', Array.from(room.cursors.values()));
    socket.to(cleanId).emit('cursorUpdate', myCursorData);

    emitRoomState(room);
    broadcastRoomList();
  });

  socket.on('cursorMove', (data) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;

    const x = Math.max(-2.5, Math.min(2.5, Number(data.x) || 0));
    const y = Math.max(-2.5, Math.min(2.5, Number(data.y) || 0));
    const laser = Boolean(data.laser);
    const cleanNick = socket.data.playerName || '플레이어';

    const cursorPayload = {
      id: socket.id,
      playerId: socket.id,
      nickname: cleanNick,
      playerName: cleanNick,
      role: socket.data.role,
      stoneColor: socket.data.stoneColor,
      cursorColor: socket.data.cursorColor,
      x,
      y,
      laser
    };

    room.cursors.set(socket.id, cursorPayload);
    socket.to(roomId).emit('cursorUpdate', cursorPayload);
  });

  socket.on('cursorClick', ({ x, y }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('cursorClickRipple', {
      playerId: socket.id,
      cursorColor: socket.data.cursorColor,
      x: Number(x) || 0,
      y: Number(y) || 0
    });
  });

  // 서로 다른 3명 이상의 플레이어가 8초 내 동일 GIF 발동 시 콤보 공명
  socket.on('sendEmote', ({ emoteId, x, y }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;

    const idNum = Number(emoteId);
    if (!Number.isInteger(idNum) || idNum < 1 || idNum > 19) return;

    socket.to(roomId).emit('emoteBroadcast', {
      id: socket.id,
      playerId: socket.id,
      nickname: socket.data.playerName,
      playerName: socket.data.playerName,
      role: socket.data.role,
      emoteId: idNum,
      x: Number(x) || 0,
      y: Number(y) || 0
    });

    const now = Date.now();
    room.emoteComboLog = room.emoteComboLog.filter((item) => now - item.time <= COMBO_WINDOW_MS);
    room.emoteComboLog.push({ emoteId: idNum, time: now, playerId: socket.id });

    const uniquePlayers = new Set(
      room.emoteComboLog
        .filter((item) => item.emoteId === idNum)
        .map((item) => item.playerId)
    );

    if (uniquePlayers.size >= 3) {
      io.to(roomId).emit('comboResonance', {
        emoteId: idNum,
        count: uniquePlayers.size
      });
      room.emoteComboLog = room.emoteComboLog.filter((item) => item.emoteId !== idNum);
    }
  });

  socket.on('voteHeatmap', ({ row, col }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.status !== 'playing' || socket.data.role !== 'spectator') return;
    if (
      row < 0 || row >= BOARD_SIZE ||
      col < 0 || col >= BOARD_SIZE ||
      room.board[row][col] !== null
    ) {
      return;
    }

    const prev = room.heatmapVotes.get(socket.id);
    if (prev && prev.row === row && prev.col === col) {
      room.heatmapVotes.delete(socket.id);
    } else {
      room.heatmapVotes.set(socket.id, { row, col });
    }
    broadcastHeatmapToSpectators(room);
  });

  // ==========================================
  // 실시간 채팅 + "나는 빡빡이다" 감지 팝업 / "오냐" 한 수 무르기
  // ==========================================
  socket.on('sendChat', (msg) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    const text = String(msg || '').trim().slice(0, 120);
    if (!text) return;

    io.to(roomId).emit('chatMessage', {
      system: false,
      senderId: socket.id,
      senderName: socket.data.playerName,
      nickname: socket.data.playerName,
      role: socket.data.role,
      stoneColor: socket.data.stoneColor,
      cursorColor: socket.data.cursorColor,
      text
    });

    if (room.status !== 'playing') return;
    const senderPlayer = room.players.find((p) => p.id === socket.id);
    if (!senderPlayer) return;

    // 1) 상대방 턴일 때 "나는 빡빡이다" 입력 감지 -> 상대 대국자 화면에 안내 팝업 발송
    if (text === '나는 빡빡이다') {
      if (
        room.turn !== senderPlayer.color &&
        room.history.length > 0 &&
        room.lastMove &&
        room.lastMove.color === senderPlayer.color
      ) {
        const opponent = room.players.find((p) => p.id !== socket.id);
        room.pendingUndo = {
          requesterId: socket.id,
          moveNumber: room.history.length
        };
        io.to(roomId).emit('chatMessage', {
          system: true,
          text: `🙏 [${senderPlayer.nickname}]님이 머리를 깎으며 한 수 무르기를 애원합니다! 상대방이 채팅에 "오냐"를 입력하면 1수 무르기가 성사됩니다.`
        });
        if (opponent) {
          io.to(opponent.id).emit('undoRequested', {
            requesterName: senderPlayer.nickname
          });
        }
      }
      return;
    }

    // 2) 무르기 요청 대기 중 상대방이 "오냐" 입력 시 1수 무르기 집행 & 팝업 닫기
    if (text === '오냐' && room.pendingUndo) {
      if (
        senderPlayer.id !== room.pendingUndo.requesterId &&
        room.turn === senderPlayer.color &&
        room.history.length === room.pendingUndo.moveNumber &&
        room.history.length > 0
      ) {
        const undoneMove = room.history.pop();
        room.board[undoneMove.row][undoneMove.col] = null;
        room.lastMove = room.history.length > 0 ? room.history[room.history.length - 1] : null;
        room.turn = undoneMove.color;
        clearPendingUndo(room);

        room.heatmapVotes.clear();
        broadcastHeatmapToSpectators(room);
        startTurnTimer(room);

        io.to(roomId).emit('chatMessage', {
          system: true,
          text: `✨ 대인배 [${senderPlayer.nickname}]님이 "오냐"를 외쳐 한 수 무르기를 허락했습니다!`
        });
        emitRoomState(room);
      }
    }
  });

  socket.on('swapSides', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.status === 'playing') return;
    const isPlayer = room.players.some((p) => p.id === socket.id);
    if (!isPlayer) return;

    room.players.forEach((p) => {
      p.color = p.color === 'black' ? 'white' : 'black';
      const sock = io.sockets.sockets.get(p.id);
      if (sock) sock.data.stoneColor = p.color;

      const cur = room.cursors.get(p.id);
      if (cur) {
        cur.stoneColor = p.color;
        io.to(room.id).emit('cursorUpdate', cur);
      }
      io.to(p.id).emit('colorChanged', p.color);
    });

    io.to(room.id).emit('chatMessage', {
      system: true,
      text: '🔄 흑돌이랑 백돌 자리를 바꿨습니다!'
    });
    emitRoomState(room);
  });

  socket.on('placeStone', ({ row, col }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.status !== 'playing') return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || player.color !== room.turn) return;

    if (
      row < 0 || row >= BOARD_SIZE ||
      col < 0 || col >= BOARD_SIZE ||
      room.board[row][col] !== null
    ) {
      return;
    }

    if (player.color === 'black' && isForbiddenForBlack(room.board, row, col)) {
      socket.emit('invalidMove', '🚫 거긴 흑돌 금수(3-3, 4-4, 장목) 자리라 못 둡니다!');
      return;
    }

    // 상대방이 무르기를 받아주지 않고 다음 돌을 두면 기존 무르기 요청 및 팝업 초기화
    clearPendingUndo(room);

    room.board[row][col] = player.color;
    const moveNumber = room.history.length + 1;
    room.lastMove = { row, col, color: player.color, moveNumber };
    room.history.push(room.lastMove);

    room.heatmapVotes.clear();
    broadcastHeatmapToSpectators(room);

    const winLine = getWinningLine(room.board, row, col, player.color);
    if (winLine) {
      clearRoomTimers(room);
      room.status = 'finished';
      room.winLine = winLine;
      player.wins += 1;
      emitRoomState(room, {
        winner: player,
        reason: `🏆 ${player.nickname}님 (${player.color === 'black' ? '흑돌' : '백돌'}) 깔끔한 5목 승리!`
      });
      broadcastRoomList();
      return;
    }

    if (room.history.length >= BOARD_SIZE * BOARD_SIZE) {
      clearRoomTimers(room);
      room.status = 'finished';
      emitRoomState(room, {
        winner: null,
        reason: '바둑판이 꽉 차서 무승부입니다!'
      });
      broadcastRoomList();
      return;
    }

    room.turn = room.turn === 'black' ? 'white' : 'black';
    startTurnTimer(room);
    emitRoomState(room);
  });

  socket.on('surrender', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.status !== 'playing') return;
    const loser = room.players.find((p) => p.id === socket.id);
    if (!loser) return;

    clearRoomTimers(room);
    clearPendingUndo(room);
    room.status = 'finished';
    room.heatmapVotes.clear();
    broadcastHeatmapToSpectators(room);

    const winner = room.players.find((p) => p.id !== socket.id);
    if (winner) winner.wins += 1;

    emitRoomState(room, {
      winner,
      reason: `🏳️ ${loser.nickname}님이 돌을 거두었습니다 (기권).`
    });
    broadcastRoomList();
  });

  socket.on('restartGame', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.status !== 'finished' || room.players.length < 2) return;
    const isPlayer = room.players.some((p) => p.id === socket.id);
    if (!isPlayer) return;

    room.players.forEach((p) => {
      p.color = p.color === 'black' ? 'white' : 'black';
      const sock = io.sockets.sockets.get(p.id);
      if (sock) sock.data.stoneColor = p.color;

      const cur = room.cursors.get(p.id);
      if (cur) {
        cur.stoneColor = p.color;
        io.to(room.id).emit('cursorUpdate', cur);
      }
      io.to(p.id).emit('colorChanged', p.color);
    });

    room.board = createEmptyBoard();
    room.history = [];
    room.turn = 'black';
    room.status = 'playing';
    room.lastMove = null;
    room.winLine = null;
    clearPendingUndo(room);
    room.heatmapVotes.clear();
    broadcastHeatmapToSpectators(room);

    startTurnTimer(room);
    io.to(room.id).emit('chatMessage', {
      system: true,
      text: '🔄 흑/백 바꿔서 리매치 갑니다!'
    });
    emitRoomState(room);
    broadcastRoomList();
  });

  function handleLeave() {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    socket.leave(roomId);
    delete socket.data.roomId;

    if (!room) return;
    room.cursors.delete(socket.id);
    room.heatmapVotes.delete(socket.id);
    io.to(roomId).emit('cursorRemove', { playerId: socket.id, id: socket.id });
    broadcastHeatmapToSpectators(room);

    const wasPlayer = room.players.some((p) => p.id === socket.id);
    room.players = room.players.filter((p) => p.id !== socket.id);
    room.spectators = room.spectators.filter((s) => s.id !== socket.id);

    if (room.players.length === 0 && room.spectators.length === 0) {
      clearRoomTimers(room);
      rooms.delete(roomId);
      broadcastRoomList();
      return;
    }

    if (wasPlayer) {
      clearRoomTimers(room);
      clearPendingUndo(room);
      room.status = 'waiting';
      room.board = createEmptyBoard();
      room.history = [];
      room.turn = 'black';
      room.lastMove = null;
      room.winLine = null;
      room.timeLeft = TURN_TIME_LIMIT;
      room.heatmapVotes.clear();
      broadcastHeatmapToSpectators(room);

      if (room.players.length === 1) {
        room.players[0].color = 'black';
        const remainSock = io.sockets.sockets.get(room.players[0].id);
        if (remainSock) remainSock.data.stoneColor = 'black';
        const remainCur = room.cursors.get(room.players[0].id);
        if (remainCur) {
          remainCur.stoneColor = 'black';
          io.to(room.id).emit('cursorUpdate', remainCur);
        }
        io.to(room.players[0].id).emit('colorChanged', 'black');
      }

      io.to(roomId).emit('chatMessage', {
        system: true,
        text: `👋 대국자 ${socket.data.playerName}님이 나가셔서 대기 상태로 돌아갑니다.`
      });
    } else {
      io.to(roomId).emit('chatMessage', {
        system: true,
        text: `👋 구경하던 ${socket.data.playerName}님이 나갔습니다.`
      });
    }

    emitRoomState(room);
    broadcastRoomList();
  }

  socket.on('leaveRoom', handleLeave);
  socket.on('disconnect', handleLeave);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[OMOK LIVE PRO] Server running on http://localhost:${PORT}`);
});