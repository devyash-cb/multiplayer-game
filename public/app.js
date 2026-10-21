const socket = io();

// Generate or retrieve stable session identifier
let sessionId = localStorage.getItem('sessionId');
if (!sessionId) {
    sessionId = Math.random().toString(36).substring(2, 15);
    localStorage.setItem('sessionId', sessionId);
}

// Global player name handling
const savedName = localStorage.getItem('playerName') || 'Player' + Math.floor(Math.random() * 1000);
const nameInput = document.getElementById('player-name');
if (nameInput) {
    nameInput.value = savedName;
    nameInput.addEventListener('change', (e) => {
        localStorage.setItem('playerName', e.target.value.trim() || 'Player');
    });
}

// Resume session on connection
socket.on('connect', () => {
    socket.emit('session:resume', { 
        sessionId, 
        name: localStorage.getItem('playerName') || savedName 
    });
});

socket.on('session:acknowledged', (data) => {
    const path = window.location.pathname;
    // Redirect logic to ensure player is on the correct page
    if (data.roomId && !path.includes('room.html') && !path.includes('game.html')) {
        window.location.href = `/room.html?id=${data.roomId}`;
    }
});

function displayError(elementId, message) {
    const el = document.getElementById(elementId);
    if (el) {
        el.textContent = message;
        el.style.display = 'block';
        setTimeout(() => el.style.display = 'none', 3000);
    }
}

// Page Specific Logic
const path = window.location.pathname;

if (path.includes('create.html')) {
    document.getElementById('create-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const roomData = {
            name: document.getElementById('room-name').value,
            password: document.getElementById('room-password').value,
            mode: document.getElementById('game-mode').value,
            maxPlayers: document.getElementById('max-players').value
        };

        socket.emit('room:create', roomData, (response) => {
            if (response.error) displayError('create-error', response.error);
            else window.location.href = `/room.html?id=${response.roomId}`;
        });
    });
}

if (path.includes('join.html')) {
    socket.emit('room:list', renderRoomList);

    function renderRoomList(rooms) {
        const container = document.getElementById('room-list');
        if (!container) return;
        
        container.innerHTML = rooms.length === 0 ? '<p>No public rooms available.</p>' : '';
        
        rooms.forEach(room => {
            const div = document.createElement('div');
            div.className = 'room-card';
            div.innerHTML = `
                <h3>${room.name} (${room.mode})</h3>
                <p>Players: ${room.currentPlayers}/${room.maxPlayers}</p>
                ${room.requiresPassword ? '<p>🔒 Password Required</p>' : ''}
                <button onclick="joinRoom('${room.id}', ${room.requiresPassword})">Join</button>
            `;
            container.appendChild(div);
        });
    }

    window.joinRoom = function(roomId, requiresPassword) {
        let password = null;
        if (requiresPassword) {
            password = prompt('Enter room password:');
            if (password === null) return; 
        }
        
        socket.emit('room:join', { roomId, password }, (response) => {
            if (response.error) displayError('join-error', response.error);
            else window.location.href = `/room.html?id=${response.roomId}`;
        });
    };
}

if (path.includes('room.html')) {
    const urlParams = new URLSearchParams(window.location.search);
    const expectedRoomId = urlParams.get('id');

    socket.on('room:update', (room) => {
        document.getElementById('room-name-display').textContent = room.name;
        document.getElementById('room-mode-display').textContent = room.mode;
        document.getElementById('player-count').textContent = `${room.players.length}/${room.maxPlayers}`;

        const list = document.getElementById('player-list');
        list.innerHTML = '';
        
        let amIOwner = false;

        room.players.forEach(p => {
            const li = document.createElement('li');
            li.textContent = `${p.name} ${p.isOwner ? '(Owner)' : ''}`;
            
            // Connection Status UI Fix
            if (!p.connected) {
                li.style.color = 'gray';
                li.textContent += ' - Reconnecting...';
            }
            
            if (p.isOwner && p.name === (localStorage.getItem('playerName') || savedName)) {
                amIOwner = true;
            }
            
            list.appendChild(li);
        });

        const startBtn = document.getElementById('start-btn');
        if (startBtn) {
            startBtn.style.display = amIOwner ? 'block' : 'none';
            startBtn.disabled = room.players.length < 2;
        }
    });

    document.getElementById('start-btn')?.addEventListener('click', () => {
        socket.emit('room:start', (response) => {
            if (response && response.error) displayError('room-error', response.error);
        });
    });

    document.getElementById('leave-btn')?.addEventListener('click', () => {
        socket.emit('room:leave');
        window.location.href = '/index.html';
    });

    socket.on('game:started', (data) => {
        window.location.href = `/game.html?mode=${data.mode}`;
    });
          }
          
