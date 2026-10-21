const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();
const players = new Map(); // stable playerKey -> player record
const SOCKET_GRACE_MS = 45_000;

app.get("/health", (_req, res) => {
  res.json({ status: "ok", rooms: rooms.size });
});
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/create", (_req, res) => res.sendFile(path.join(__dirname, "create.html")));
app.get("/join", (_req, res) => res.sendFile(path.join(__dirname, "join.html")));
app.get("/room", (_req, res) => res.sendFile(path.join(__dirname, "room.html")));

function cleanName(value, maxLength = 20) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}
function publicRoom(room) {
  return {
    id: room.id, name: room.name, game: room.game,
    maxPlayers: room.maxPlayers, players: room.players.size,
    status: room.status, locked: Boolean(room.passwordHash)
  };
}
function roomState(room) {
  return {
    ...publicRoom(room),
    ownerId: room.ownerKey,
    players: [...room.players.values()].map(player => ({
      id: player.key,
      name: player.name,
      ready: true,
      isOwner: player.key === room.ownerKey,
      connected: Boolean(player.socketId && io.sockets.sockets.has(player.socketId))
    }))
  };
}
function broadcastRooms() {
  io.emit("rooms:update", [...rooms.values()].map(publicRoom));
}
function sendRoomState(room) {
  io.to(room.id).emit("room:update", roomState(room));
}
function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}
function removePlayerFromRoom(player) {
  if (!player?.roomId) return;
  const room = rooms.get(player.roomId);
  if (!room) {
    player.roomId = null;
    return;
  }
  room.players.delete(player.key);
  player.roomId = null;
  if (room.players.size === 0) {
    rooms.delete(room.id);
  } else {
    if (room.ownerKey === player.key) {
      room.ownerKey = room.players.keys().next().value;
    }
    sendRoomState(room);
  }
  broadcastRooms();
}
function joinSocketToRoom(socket, player, room) {
  socket.join(room.id);
  socket.data.playerKey = player.key;
  socket.data.roomId = room.id;
  player.socketId = socket.id;
  player.roomId = room.id;
  player.disconnectedAt = null;
}
function resumePlayer(socket, data, callback) {
  const key = typeof data?.playerKey === "string" ? data.playerKey : "";
  const name = cleanName(data?.name);
  if (!/^[a-f0-9-]{20,80}$/i.test(key)) {
    callback?.({ ok: false, error: "Invalid player session. Refresh the homepage and try again." });
    return;
  }
  let player = players.get(key);
  if (!player) {
    player = { key, name: name || "Player", socketId: socket.id, roomId: null, disconnectedAt: null };
    players.set(key, player);
  } else {
    if (name) player.name = name;
    const oldSocketId = player.socketId;
    if (oldSocketId && oldSocketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(oldSocketId);
      if (oldSocket) {
        oldSocket.data.replacedByReconnect = true;
        oldSocket.disconnect(true);
      }
    }
    player.socketId = socket.id;
    player.disconnectedAt = null;
  }
  socket.data.playerKey = key;
  socket.data.name = player.name;
  socket.data.roomId = player.roomId || null;
  if (player.roomId) {
    const room = rooms.get(player.roomId);
    if (room && room.players.has(key)) {
      joinSocketToRoom(socket, player, room);
      sendRoomState(room);
    } else {
      player.roomId = null;
      socket.data.roomId = null;
    }
  }
  callback?.({ ok: true, playerKey: key, name: player.name, roomId: player.roomId || null });
}
function socketPlayer(socket) {
  const key = socket.data.playerKey;
  return key ? players.get(key) : null;
}

io.on("connection", socket => {
  socket.data.playerKey = null;
  socket.data.roomId = null;
  socket.emit("rooms:update", [...rooms.values()].map(publicRoom));

  socket.on("session:resume", (data, callback) => {
    resumePlayer(socket, data, callback);
  });

  socket.on("player:name", (rawName, callback) => {
    const player = socketPlayer(socket);
    const name = cleanName(rawName);
    if (!name) return callback?.({ ok: false, error: "Enter a valid player name." });
    if (!player) return callback?.({ ok: false, error: "Player session is not ready. Refresh and try again." });
    player.name = name;
    socket.data.name = name;
    const room = player.roomId ? rooms.get(player.roomId) : null;
    if (room && room.players.has(player.key)) {
      room.players.get(player.key).name = name;
      sendRoomState(room);
    }
    callback?.({ ok: true, name });
  });

  socket.on("rooms:list", () => {
    socket.emit("rooms:update", [...rooms.values()].map(publicRoom));
  });

  socket.on("room:create", (data, callback) => {
    const player = socketPlayer(socket);
    if (!player) return callback?.({ ok: false, error: "Player session is not ready. Refresh and try again." });
    if (player.roomId) return callback?.({ ok: false, error: "Leave your current room first." });

    const name = cleanName(data?.name, 32);
    const game = data?.game;
    const maxPlayers = Number(data?.maxPlayers);
    const password = typeof data?.password === "string" ? data.password : "";

    if (!name) return callback?.({ ok: false, error: "Enter a server name." });
    if (!["paper", "snake"].includes(game)) return callback?.({ ok: false, error: "Select a valid game." });
    if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 20) {
      return callback?.({ ok: false, error: "Maximum players must be between 2 and 20." });
    }
    if (password.length > 100) return callback?.({ ok: false, error: "Password is too long." });

    let id;
    do { id = crypto.randomBytes(4).toString("hex"); } while (rooms.has(id));
    const room = {
      id, name, game, maxPlayers,
      passwordHash: password ? hashPassword(password) : null,
      ownerKey: player.key, players: new Map(), status: "waiting", createdAt: Date.now()
    };
    room.players.set(player.key, { key: player.key, name: player.name });
    rooms.set(id, room);
    joinSocketToRoom(socket, player, room);
    sendRoomState(room);
    broadcastRooms();
    callback?.({ ok: true, roomId: id });
  });

  socket.on("room:join", (data, callback) => {
    const player = socketPlayer(socket);
    if (!player) return callback?.({ ok: false, error: "Player session is not ready. Refresh and try again." });
    if (player.roomId) return callback?.({ ok: false, error: "Leave your current room first." });
    const room = rooms.get(String(data?.roomId || ""));
    if (!room) return callback?.({ ok: false, error: "Room not found. It may have closed." });
    if (room.status !== "waiting") return callback?.({ ok: false, error: "This room is not accepting players." });
    if (room.players.size >= room.maxPlayers) return callback?.({ ok: false, error: "This room is full." });

    const suppliedPassword = typeof data?.password === "string" ? data.password : "";
    if (room.passwordHash && hashPassword(suppliedPassword) !== room.passwordHash) {
      return callback?.({ ok: false, error: "Incorrect password." });
    }
    room.players.set(player.key, { key: player.key, name: player.name });
    joinSocketToRoom(socket, player, room);
    sendRoomState(room);
    broadcastRooms();
    callback?.({ ok: true, roomId: room.id });
  });

  socket.on("room:leave", callback => {
    const player = socketPlayer(socket);
    if (player) removePlayerFromRoom(player);
    socket.leave(socket.data.roomId || "");
    socket.data.roomId = null;
    callback?.({ ok: true });
  });

  socket.on("room:start", callback => {
    const player = socketPlayer(socket);
    const room = player?.roomId ? rooms.get(player.roomId) : null;
    if (!room) return callback?.({ ok: false, error: "You are not in a room." });
    if (room.ownerKey !== player.key) return callback?.({ ok: false, error: "Only the room owner can start." });
    if (room.players.size < 2) return callback?.({ ok: false, error: "At least two players are required." });
    if (room.status !== "waiting") return callback?.({ ok: false, error: "This room has already started." });
    // The actual game engines are not connected in this repair build.
    callback?.({ ok: false, error: "Room infrastructure is working, but the game engine has not been implemented yet." });
  });

  socket.on("disconnect", () => {
    if (socket.data.replacedByReconnect) return;
    const player = socketPlayer(socket);
    if (!player || player.socketId !== socket.id) return;
    player.socketId = null;
    player.disconnectedAt = Date.now();
    const room = player.roomId ? rooms.get(player.roomId) : null;
    if (room) {
      // Keep the player slot during the grace period so page navigation/reconnects do not remove them.
      sendRoomState(room);
      setTimeout(() => {
        const current = players.get(player.key);
        if (current && !current.socketId && current.disconnectedAt &&
            Date.now() - current.disconnectedAt >= SOCKET_GRACE_MS) {
          removePlayerFromRoom(current);
          players.delete(current.key);
        }
      }, SOCKET_GRACE_MS + 100);
    } else {
      setTimeout(() => {
        const current = players.get(player.key);
        if (current && !current.socketId && !current.roomId) players.delete(current.key);
      }, SOCKET_GRACE_MS + 100);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Multiplayer server listening on port ${PORT}`);
});
