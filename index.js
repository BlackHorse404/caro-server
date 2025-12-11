const express = require("express");
const http = require("http");
const cors = require("cors");
require("dotenv").config();
const { Server } = require("socket.io");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

/* ===========================================
   CONFIG
=========================================== */
const ROOM_ID = "caro-room";
const GAME_PASSWORD = process.env.GAME_PASSWORD || "123456";
const TURN_TIME = 30;

/* ===========================================
   GAME STATE
=========================================== */
let board = {};
let turn = "X";
let winner = null;
let winLine = [];

let timeLeft = TURN_TIME;
let turnInterval = null;

// room state
let gameReady = false;
let gameStarted = false;
let startConfirmed = { X: false, O: false };

// roles
const roles = {};
const players = { X: null, O: null };

/* ===========================================
   UTILITIES
=========================================== */
function key(x, y) {
  return `${x},${y}`;
}

function getCell(x, y) {
  return board[key(x, y)] ?? ".";
}

function setCell(x, y, v) {
  board[key(x, y)] = v;
}

// khởi tạo bảng 20x20
function resetGame() {
  board = {};
  const size = 20;

  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      board[key(x, y)] = ".";
    }
  }

  turn = "X";
  winner = null;
  winLine = [];

  clearInterval(turnInterval);
  turnInterval = null;
  timeLeft = TURN_TIME;

  // clear last move (client sẽ tắt highlight)
  io.to(ROOM_ID).emit("last_move", null);
}

function publicState() {
  return {
    board,
    turn,
    winner,
    winLine
  };
}

/* ===========================================
   WIN CHECK
=========================================== */
function checkWin(x, y) {
  const s = getCell(x, y);
  if (s !== "X" && s !== "O") return null;

  const dirs = [
    [1, 0], // dọc
    [0, 1], // ngang
    [1, 1], // chéo xuống phải
    [1, -1] // chéo xuống trái
  ];

  for (let [dx, dy] of dirs) {
    let line = [[x, y]];

    let i = x + dx,
      j = y + dy;
    while (getCell(i, j) === s) {
      line.push([i, j]);
      i += dx;
      j += dy;
    }

    i = x - dx;
    j = y - dy;
    while (getCell(i, j) === s) {
      line.push([i, j]);
      i -= dx;
      j -= dy;
    }

    if (line.length >= 5) return line;
  }

  return null;
}

/* ===========================================
   AUTO MOVE
=========================================== */

function findFirstEmptyCell() {
  for (let k in board) {
    if (board[k] === ".") {
      const [x, y] = k.split(",").map(Number);
      return { x, y };
    }
  }
  return null;
}

function autoMove() {
  if (!gameStarted || winner) return;

  const cell = findFirstEmptyCell();
  if (!cell) return;

  const { x, y } = cell;
  const currentSymbol = turn;

  setCell(x, y, currentSymbol);

  // ⭐ gửi vị trí vừa đánh
  io.to(ROOM_ID).emit("last_move", { x, y, player: currentSymbol });

  const line = checkWin(x, y);
  if (line) {
    winner = currentSymbol;
    winLine = line;
    io.to(ROOM_ID).emit("state", publicState());
    return;
  }

  turn = turn === "X" ? "O" : "X";
  io.to(ROOM_ID).emit("state", publicState());
  startTurnTimer();
}

/* ===========================================
   TURN TIMER
=========================================== */

function emitTimer() {
  io.to(ROOM_ID).emit("timer", timeLeft);
}

function startTurnTimer() {
  clearInterval(turnInterval);

  timeLeft = TURN_TIME;
  emitTimer();

  turnInterval = setInterval(() => {
    timeLeft--;
    emitTimer();

    if (timeLeft <= 0) {
      clearInterval(turnInterval);
      autoMove();
    }
  }, 1000);
}

/* ===========================================
   ROOM READY CHECK
=========================================== */

function checkRoomReady() {
  if (players.X && players.O) {
    gameReady = true;
    gameStarted = false;
    startConfirmed = { X: false, O: false };

    io.to(ROOM_ID).emit("ready_to_start");
  } else {
    gameReady = false;
    gameStarted = false;
    startConfirmed = { X: false, O: false };

    io.to(ROOM_ID).emit("waiting_for_players");
  }
}

/* ===========================================
   INIT GAME
=========================================== */

resetGame();

/* ===========================================
   SOCKET.IO
=========================================== */

io.on("connection", (socket) => {
  console.log("⚡ Client connected:", socket.id);

  socket.join(ROOM_ID);

  /* -------------------------
     PASSWORD
  ------------------------- */
  socket.on("verify_password", (pass) => {
    if (pass === GAME_PASSWORD) {
      socket.emit("password_ok");
      socket.emit("state", publicState());
      socket.emit("timer", timeLeft);
    } else {
      socket.emit("password_fail");
    }
  });

  /* -------------------------
     ASSIGN ROLE
  ------------------------- */

  let symbol = "SPECTATOR";

  if (!players.X) {
    players.X = socket.id;
    symbol = "X";
  } else if (!players.O) {
    players.O = socket.id;
    symbol = "O";
  }

  roles[socket.id] = symbol;

  socket.emit("assign_role", { symbol });
  socket.emit("state", publicState());
  socket.emit("timer", timeLeft);

  checkRoomReady();

  /* -------------------------
     CONFIRM START
  ------------------------- */

  socket.on("confirm_start", () => {
    const mySymbol = roles[socket.id];
    if (mySymbol !== "X" && mySymbol !== "O") return;
    if (!gameReady) return;
    if (gameStarted) return;

    startConfirmed[mySymbol] = true;
    io.to(ROOM_ID).emit("start_confirm_update", startConfirmed);

    if (startConfirmed.X && startConfirmed.O) {
      gameStarted = true;

      resetGame();
      io.to(ROOM_ID).emit("state", publicState());
      io.to(ROOM_ID).emit("game_started");

      // ⭐ xoá highlight nước cũ
      io.to(ROOM_ID).emit("last_move", null);

      startTurnTimer();
    }
  });

  /* -------------------------
     MAKE MOVE
  ------------------------- */

  socket.on("make_move", ({ x, y }) => {
    const mySymbol = roles[socket.id];

    if (!gameStarted) return;
    if (winner) return;
    if (mySymbol !== turn) return;
    if (mySymbol !== "X" && mySymbol !== "O") return;

    if (typeof x !== "number" || typeof y !== "number") return;
    if (getCell(x, y) !== ".") return;

    setCell(x, y, mySymbol);

    // ⭐ gửi nước đi cuối cùng cho client
    io.to(ROOM_ID).emit("last_move", { x, y, player: mySymbol });

    const line = checkWin(x, y);

    if (line) {
      winner = mySymbol;
      winLine = line;
      io.to(ROOM_ID).emit("state", publicState());

      clearInterval(turnInterval);
    } else {
      turn = turn === "X" ? "O" : "X";
      io.to(ROOM_ID).emit("state", publicState());
      startTurnTimer();
    }
  });

  /* -------------------------
     RESET GAME
  ------------------------- */

  socket.on("reset_game", () => {
    const mySymbol = roles[socket.id];
    if (mySymbol !== "X" && mySymbol !== "O") return;

    resetGame();
    gameStarted = false;
    startConfirmed = { X: false, O: false };

    io.to(ROOM_ID).emit("state", publicState());

    checkRoomReady();
  });

  /* -------------------------
     DISCONNECT
  ------------------------- */

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected:", socket.id);

    const mySymbol = roles[socket.id];

    if (mySymbol === "X") players.X = null;
    if (mySymbol === "O") players.O = null;

    delete roles[socket.id];

    resetGame();
    checkRoomReady();

    io.to(ROOM_ID).emit("state", publicState());
  });
});

/* ===========================================
   START SERVER (Render.com compatible)
=========================================== */

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log("🔥 Caro realtime server running on port", PORT);
});
