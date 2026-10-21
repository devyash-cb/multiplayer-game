const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
cors: {
origin: process.env.FRONTEND_ORIGIN || true,
methods: ["GET", "POST"]
}
});

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

app.get("/health", (req, res) => {
res.json({
status: "ok",
rooms: rooms.size
});
});

app.get("/", (req, res) => {
res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/create", (req, res) => {
res.sendFile(path.join(__dirname, "create.html"));
});

app.get("/join", (req, res) => {
res.sendFile(path.join(__dirname, "join.html"));
});

app.get("/room", (req, res) => {
res.sendFile(path.join(__dirname, "room.html"));
});

function cleanName(value, maxLength = 20) {
if (typeof value !== "string") return "";
return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function publicRoom(room) {
return {
id: room.id,
name: room.name,
game: room.game,
maxPlayers: room.maxPlayers,
players: room.players.size,
status: room.status,
locked: Boolean(room.passwordHash)
};
}

function broadcastRooms() {
io.emit("rooms:update", [...rooms.values()].map(publicRoom));
}

function sendRoomState(room) {
io.to(room.id).emit("room:update", {
...publicRoom(room),
ownerId: room.ownerId,
players: [...room.players.values()].map(player => ({
id: player.id,
name: player.name,
ready: player.ready,
isOwner: player.id === room.ownerId
}))
});
}

function removePlayerFromRoom(socket) {
if (!socket.data.roomId) return;

const room = rooms.get(socket.data.roomId);
if (!room) {
socket.data.roomId = null;
return;
}

room.players.delete(socket.id);
socket.leave(room.id);
socket.data.roomId = null;

if (room.players.size === 0) {
rooms.delete(room.id);
} else {
if (room.ownerId === socket.id) {
room.ownerId = room.players.keys().next().value;
}

sendRoomState(room);

}

broadcastRooms();
}

function hashPassword(password) {
return crypto
.createHash("sha256")
.update(password)
.digest("hex");
}

io.on("connection", socket => {
socket.data.name = "Player";
socket.data.roomId = null;

socket.emit("rooms:update", [...rooms.values()].map(publicRoom));

socket.on("player:name", (rawName, callback) => {
const name = cleanName(rawName);

if (!name) {
  return callback?.({
    ok: false,
    error: "Enter a valid player name."
  });
}

socket.data.name = name;

callback?.({
  ok: true,
  name
});

});

socket.on("rooms:list", () => {
socket.emit(
"rooms:update",
[...rooms.values()].map(publicRoom)
);
});

socket.on("room:create", (data, callback) => {
if (socket.data.roomId) {
return callback?.({
ok: false,
error: "Leave your current room first."
});
}

const name = cleanName(data?.name, 32);
const game = data?.game;
const maxPlayers = Number(data?.maxPlayers);
const password = typeof data?.password === "string"
  ? data.password
  : "";

if (!name) {
  return callback?.({
    ok: false,
    error: "Enter a server name."
  });
}

if (!["paper", "snake"].includes(game)) {
  return callback?.({
    ok: false,
    error: "Select a valid game."
  });
}

if (
  !Number.isInteger(maxPlayers) ||
  maxPlayers < 2 ||
  maxPlayers > 20
) {
  return callback?.({
    ok: false,
    error: "Maximum players must be between 2 and 20."
  });
}

if (password.length > 100) {
  return callback?.({
    ok: false,
    error: "Password is too long."
  });
}

const id = crypto.randomBytes(4).toString("hex");

const room = {
  id,
  name,
  game,
  maxPlayers,
  passwordHash: password ? hashPassword(password) : null,
  ownerId: socket.id,
  players: new Map(),
  status: "waiting",
  createdAt: Date.now()
};

room.players.set(socket.id, {
  id: socket.id,
  name: socket.data.name,
  ready: true
});

rooms.set(id, room);
socket.data.roomId = id;
socket.join(id);

sendRoomState(room);
broadcastRooms();

callback?.({
  ok: true,
  roomId: id
});

});

socket.on("room:join", (data, callback) => {
if (socket.data.roomId) {
return callback?.({
ok: false,
error: "Leave your current room first."
});
}

const room = rooms.get(String(data?.roomId || ""));

if (!room) {
  return callback?.({
    ok: false,
    error: "Room not found."
  });
}

if (room.status !== "waiting") {
  return callback?.({
    ok: false,
    error: "This room is not accepting players."
  });
}

if (room.players.size >= room.maxPlayers) {
  return callback?.({
    ok: false,
    error: "This room is full."
  });
}

const suppliedPassword =
  typeof data?.password === "string" ? data.password : "";

if (
  room.passwordHash &&
  hashPassword(suppliedPassword) !== room.passwordHash
) {
  return callback?.({
    ok: false,
    error: "Incorrect password."
  });
}

room.players.set(socket.id, {
  id: socket.id,
  name: socket.data.name,
  ready: true
});

socket.data.roomId = room.id;
socket.join(room.id);

sendRoomState(room);
broadcastRooms();

callback?.({
  ok: true,
  roomId: room.id
});

});

socket.on("room:leave", callback => {
removePlayerFromRoom(socket);
callback?.({ ok: true });
});

socket.on("disconnect", () => {
removePlayerFromRoom(socket);
});
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
console.log("Multiplayer server listening on port ${PORT}");
});
