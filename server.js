const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from the root directory to match your structure
app.use(express.static(__dirname));
app.use('/public', express.static(path.join(__dirname, 'public')));

// In-memory data stores
const sessions = new Map(); // sessionID -> { socketId, name, roomId, connected, disconnectTimer }
const rooms = new Map();    // roomId -> { id, name, password, mode, maxPlayers, ownerSessionId, state, players: Set<sessionID> }

const GRACE_PERIOD_MS = 45000; // 45 seconds

function generateId() {
    return Math.random().toString(36).substring(2, 9);
}

function broadcastRoomUpdate(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    const playerList = Array.from(room.players).map(sessionId => {
        const session = sessions.get(sessionId);
        return {
            name: session.name,
            connected: session.connected,
            isOwner: room.ownerSessionId === sessionId
        };
    });

    io.to(roomId).emit('room:update', {
        id: room.id,
        name: room.name,
        mode: room.mode,
        maxPlayers: room.maxPlayers,
        state: room.state,
        players: playerList
    });
}

function removePlayerFromRoom(sessionId, roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    room.players.delete(sessionId);
    const session = sessions.get(sessionId);
    if (session) session.roomId = null;

    if (room.players.size === 0) {
        rooms.delete(roomId);
    } else if (room.ownerSessionId === sessionId) {
        // Transfer ownership to the next available player
        const nextOwner = Array.from(room.players)[0];
        room.ownerSessionId = nextOwner;
        broadcastRoomUpdate(roomId);
    } else {
        broadcastRoomUpdate(roomId);
    }
}

io.on('connection', (socket) => {
    socket.on('session:resume', ({ sessionId, name }) => {
        let session = sessions.get(sessionId);
        
        if (session) {
            clearTimeout(session.disconnectTimer);
            session.socketId = socket.id;
            session.name = name;
            session.connected = true;
            
            if (session.roomId && rooms.has(session.roomId)) {
                socket.join(session.roomId);
                broadcastRoomUpdate(session.roomId);
            }
        } else {
            session = { socketId: socket.id, name, roomId: null, connected: true };
            sessions.set(sessionId, session);
        }
        socket.emit('session:acknowledged', { sessionId, roomId: session.roomId });
    });

    socket.on('room:create', (data, callback) => {
        const session = Array.from(sessions.values()).find(s => s.socketId === socket.id);
        if (!session) return callback({ error: 'Session not found' });

        const roomId = generateId();
        rooms.set(roomId, {
            id: roomId,
            name: data.name,
            password: data.password || null,
            mode: data.mode,
            maxPlayers: parseInt(data.maxPlayers, 10),
            ownerSessionId: getSessionIdBySocket(socket.id),
            state: 'waiting',
            players: new Set([getSessionIdBySocket(socket.id)])
        });

        session.roomId = roomId;
        socket.join(roomId);
        callback({ success: true, roomId });
    });

    socket.on('room:join', (data, callback) => {
        const session = Array.from(sessions.values()).find(s => s.socketId === socket.id);
        if (!session) return callback({ error: 'Session not found' });

        const room = rooms.get(data.roomId);
        if (!room) return callback({ error: 'Room not found' });
        if (room.state !== 'waiting') return callback({ error: 'Match already in progress' });
        if (room.players.size >= room.maxPlayers) return callback({ error: 'Room is full' });
        if (room.password && room.password !== data.password) return callback({ error: 'Incorrect password' });

        session.roomId = room.id;
        room.players.add(getSessionIdBySocket(socket.id));
        socket.join(room.id);
        
        broadcastRoomUpdate(room.id);
        callback({ success: true, roomId: room.id });
    });

    socket.on('room:list', (callback) => {
        const publicRooms = Array.from(rooms.values())
            .filter(r => r.state === 'waiting')
            .map(r => ({
                id: r.id,
                name: r.name,
                mode: r.mode,
                currentPlayers: r.players.size,
                maxPlayers: r.maxPlayers,
                requiresPassword: !!r.password
            }));
        callback(publicRooms);
    });

    socket.on('room:start', (callback) => {
        const sessionId = getSessionIdBySocket(socket.id);
        const session = sessions.get(sessionId);
        if (!session || !session.roomId) return;

        const room = rooms.get(session.roomId);
        if (!room) return;

        if (room.ownerSessionId !== sessionId) return callback({ error: 'Only the owner can start the match' });
        if (room.players.size < 2) return callback({ error: 'At least 2 players required' });

        room.state = 'playing';
        io.to(room.id).emit('game:started', { mode: room.mode });
    });

    socket.on('room:leave', () => {
        const sessionId = getSessionIdBySocket(socket.id);
        const session = sessions.get(sessionId);
        if (session && session.roomId) {
            socket.leave(session.roomId);
            removePlayerFromRoom(sessionId, session.roomId);
        }
    });

    socket.on('disconnect', () => {
        const sessionId = getSessionIdBySocket(socket.id);
        const session = sessions.get(sessionId);
        
        if (session) {
            session.connected = false;
            if (session.roomId) broadcastRoomUpdate(session.roomId);

            session.disconnectTimer = setTimeout(() => {
                if (session.roomId) removePlayerFromRoom(sessionId, session.roomId);
                sessions.delete(sessionId);
            }, GRACE_PERIOD_MS);
        }
    });

    function getSessionIdBySocket(socketId) {
        for (const [id, session] of sessions.entries()) {
            if (session.socketId === socketId) return id;
        }
        return null;
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
