const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

/** ================== CONFIG ================== */
const ROOM_ID = "caro-room";
const GAME_PASSWORD = "123456";   // password để vào game
const TURN_TIME = 30;             // thời gian mỗi lượt (giây)

/** ================== GAME STATE ================== */
// board["x,y"] = ".", "X", "O"
let board = {};
let turn = "X";
let winner = null;
let winLine = [];

// timer
let turnInterval = null;
let timeLeft = TURN_TIME;

// room / game state
let gameReady = false;  // đã đủ X & O chưa
let gameStarted = false; // trận đã bắt đầu chưa
let startConfirmed = { X: false, O: false }; // mỗi bên có bấm "bắt đầu" chưa

// socketId -> "X" | "O" | "SPECTATOR"
const roles = {};
// lưu socket id của X / O
const players = {
  X: null,
  O: null
};

/** ================== HELPER ================== */
function getKey(x, y) {
  return `${x},${y}`;
}

function getCell(x, y) {
  const v = board[getKey(x, y)];
  return v === undefined ? "." : v;
}

function setCell(x, y, v) {
  board[getKey(x, y)] = v;
}

// khởi tạo bảng 20x20
function resetGame() {
  board = {};
  const size = 20;
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      board[getKey(i, j)] = ".";
    }
  }

  turn = "X";
  winner = null;
  winLine = [];

  if (turnInterval) {
    clearInterval(turnInterval);
    turnInterval = null;
  }
  timeLeft = TURN_TIME;
}

function publicState() {
  return {
    board,
    turn,
    winner,
    winLine
  };
}

// tìm đường thắng (>= 5 quân liên tiếp)
function checkWin(x, y) {
  const symbol = getCell(x, y);
  if (symbol !== "X" && symbol !== "O") return null;

  const dirs = [
    [1, 0],  // dọc
    [0, 1],  // ngang
    [1, 1],  // chéo xuống phải
    [1, -1]  // chéo xuống trái
  ];

  for (const [dx, dy] of dirs) {
    let line = [[x, y]];

    // 1 phía
    let i = x + dx;
    let j = y + dy;
    while (getCell(i, j) === symbol) {
      line.push([i, j]);
      i += dx;
      j += dy;
    }

    // phía ngược lại
    i = x - dx;
    j = y - dy;
    while (getCell(i, j) === symbol) {
      line.push([i, j]);
      i -= dx;
      j -= dy;
    }

    if (line.length >= 5) {
      return line;
    }
  }

  return null;
}

// tìm ô trống đầu tiên để auto đánh khi hết giờ
function findFirstEmptyCell() {
  for (const key in board) {
    if (board[key] === ".") {
      const [x, y] = key.split(",").map(Number);
      return { x, y };
    }
  }
  return null;
}

/** ================== TIMER ================== */

function emitTimer() {
  io.to(ROOM_ID).emit("timer", timeLeft);
}

function startTurnTimer() {
  if (turnInterval) {
    clearInterval(turnInterval);
    turnInterval = null;
  }

  timeLeft = TURN_TIME;
  emitTimer();

  turnInterval = setInterval(() => {
    timeLeft -= 1;
    emitTimer();

    if (timeLeft <= 0) {
      clearInterval(turnInterval);
      turnInterval = null;
      autoMove();
    }
  }, 1000);
}

// auto đánh khi hết giờ
function autoMove() {
  if (winner || !gameStarted) return;

  const empty = findFirstEmptyCell();
  if (!empty) return;

  const { x, y } = empty;
  const mySymbol = turn;

  setCell(x, y, mySymbol);
  const line = checkWin(x, y);

  if (line) {
    winner = mySymbol;
    winLine = line;
    io.to(ROOM_ID).emit("state", publicState());
  } else {
    turn = turn === "X" ? "O" : "X";
    io.to(ROOM_ID).emit("state", publicState());
    startTurnTimer();
  }
}

// check nếu đã đủ 2 người chơi
function checkAndAnnounceReady() {
  if (players.X && players.O) {
    gameReady = true;
    gameStarted = false;
    startConfirmed = { X: false, O: false };
    io.to(ROOM_ID).emit("ready_to_start", {
      message: "Đã đủ người chơi. Hãy xác nhận để bắt đầu!"
    });
  } else {
    gameReady = false;
    gameStarted = false;
    startConfirmed = { X: false, O: false };
    io.to(ROOM_ID).emit("waiting_for_players", {
      message: "Đang đợi đủ 2 người chơi..."
    });
  }
}

/** ================== INIT ================== */
resetGame();

/** ================== SOCKET ================== */

io.on("connection", (socket) => {
  console.log()
  console.log("Client connected:", socket.id, "IP:", socket.handshake.address);
  socket.join(ROOM_ID);

  // verify password
  socket.on("verify_password", (pass) => {
    if (pass === GAME_PASSWORD) {
      socket.emit("password_ok");
      socket.emit("state", publicState());
      socket.emit("timer", timeLeft);
    } else {
      socket.emit("password_fail");
    }
  });

  // gán role cho socket
  let symbol;
  if (!players.X) {
    players.X = socket.id;
    symbol = "X";
  } else if (!players.O) {
    players.O = socket.id;
    symbol = "O";
  } else {
    symbol = "SPECTATOR";
  }
  roles[socket.id] = symbol;

  socket.emit("assign_role", { symbol });
  socket.emit("state", publicState());
  socket.emit("timer", timeLeft);

  // báo trạng thái phòng
  checkAndAnnounceReady();

  // xác nhận bắt đầu trận
  socket.on("confirm_start", () => {
    const mySymbol = roles[socket.id];
    if (mySymbol !== "X" && mySymbol !== "O") return;
    if (!gameReady) return;
    if (gameStarted) return;

    startConfirmed[mySymbol] = true;
    io.to(ROOM_ID).emit("start_confirm_update", startConfirmed);

    if (startConfirmed.X && startConfirmed.O) {
      // cả 2 đã xác nhận => bắt đầu trận
      gameStarted = true;
      resetGame(); // reset board, timer
      io.to(ROOM_ID).emit("state", publicState());
      io.to(ROOM_ID).emit("game_started");
      startTurnTimer();
    }
  });

  // xử lý đánh cờ
  socket.on("make_move", ({ x, y }) => {
    const mySymbol = roles[socket.id];

    if (mySymbol !== "X" && mySymbol !== "O") return;
    if (mySymbol !== turn) return;
    if (!gameStarted) return;
    if (winner) return;

    if (typeof x !== "number" || typeof y !== "number") return;
    if (getCell(x, y) !== ".") return;

    setCell(x, y, mySymbol);
    const line = checkWin(x, y);

    if (line) {
      winner = mySymbol;
      winLine = line;
      io.to(ROOM_ID).emit("state", publicState());
      if (turnInterval) {
        clearInterval(turnInterval);
        turnInterval = null;
      }
    } else {
      turn = turn === "X" ? "O" : "X";
      io.to(ROOM_ID).emit("state", publicState());
      startTurnTimer();
    }
  });

  // reset game (chỉ X/O được reset)
  socket.on("reset_game", () => {
    const mySymbol = roles[socket.id];
    if (mySymbol === "X" || mySymbol === "O") {
      resetGame();
      gameStarted = false;
      startConfirmed = { X: false, O: false };
      io.to(ROOM_ID).emit("state", publicState());
      checkAndAnnounceReady(); // vẫn đủ người -> lại yêu cầu xác nhận bắt đầu
    }
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    const mySymbol = roles[socket.id];

    if (mySymbol === "X") players.X = null;
    if (mySymbol === "O") players.O = null;

    delete roles[socket.id];

    // nếu 1 trong 2 người chơi rời -> reset ván & chờ người mới
    resetGame();
    gameReady = false;
    gameStarted = false;
    startConfirmed = { X: false, O: false };
    io.to(ROOM_ID).emit("state", publicState());
    io.to(ROOM_ID).emit("waiting_for_players", {
      message: "Đang đợi đủ 2 người chơi..."
    });
  });
});

/** ================== START SERVER ================== */

server.listen(3001, () => {
  console.log("🔥 Caro Infinite Server running on port 3001");
});
