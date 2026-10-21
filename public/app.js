const socket = io();

const $ = id => document.getElementById(id);

function showMessage(element, message) {
if (element) element.textContent = message;
}

function getPlayerName() {
return sessionStorage.getItem("arenaPlayerName") || "";
}

function setPlayerName(name) {
sessionStorage.setItem("arenaPlayerName", name);
}

function registerName(callback) {
const name = getPlayerName();

if (!name) {
showMessage($("message"), "Enter your player name first.");
location.href = "/";
return;
}

socket.emit("player:name", name, result => {
if (!result?.ok) {
showMessage($("message"), result?.error || "Could not register name.");
return;
}

callback?.();

});
}

function escapeHTML(value) {
return String(value).replace(/[&<>"']/g, character => ({
"&": "&",
"<": "<",
">": ">",
'"': """,
"'": "'"
})[character]);
}

function renderRooms(rooms, target) {
if (!target) return;

target.replaceChildren();

if (!rooms.length) {
const empty = document.createElement("p");
empty.textContent = "No servers available. Create one!";
target.appendChild(empty);
return;
}

for (const room of rooms) {
const card = document.createElement("article");
card.className = "server-card";

const title = document.createElement("h3");
title.textContent = room.name;

const details = document.createElement("p");
details.textContent =
  `${room.game === "paper" ? "Paper.io" : "Snake"} · ` +
  `${room.players}/${room.maxPlayers} players · ` +
  `${room.locked ? "🔒 Password required" : "Public"} · ` +
  room.status;

const button = document.createElement("button");
button.textContent = "Join Server";
button.disabled = room.status !== "waiting" ||
  room.players >= room.maxPlayers;

button.addEventListener("click", () => {
  if (!getPlayerName()) {
    location.href = "/";
    return;
  }

  let password = "";

  if (room.locked) {
    password = prompt("Enter the room password") || "";
  }

  registerName(() => {
    socket.emit("room:join", {
      roomId: room.id,
      password
    }, result => {
      if (!result?.ok) {
        showMessage($("message"), result?.error || "Join failed.");
        return;
      }

      location.href = `/room?id=${encodeURIComponent(room.id)}`;
    });
  });
});

card.append(title, details, button);
target.appendChild(card);

}
}

socket.on("connect", () => {
socket.emit("rooms:list");
});

socket.on("rooms:update", rooms => {
renderRooms(rooms, $("serverList"));
});

const nameInput = $("playerName");

if (nameInput) {
nameInput.value = getPlayerName();

$("createButton")?.addEventListener("click", () => {
const name = nameInput.value.trim();

if (!name) {
  return showMessage($("message"), "Enter your name first.");
}

setPlayerName(name);
location.href = "/create";

});

$("joinButton")?.addEventListener("click", () => {
const name = nameInput.value.trim();

if (!name) {
  return showMessage($("message"), "Enter your name first.");
}

setPlayerName(name);
location.href = "/join";

});

$("refreshButton")?.addEventListener("click", () => {
socket.emit("rooms:list");
});
}

const createForm = $("createForm");

if (createForm) {
registerName();

createForm.addEventListener("submit", event => {
event.preventDefault();

const data = {
  name: $("serverName").value.trim(),
  password: $("password").value,
  game: $("game").value,
  maxPlayers: Number($("maxPlayers").value)
};

registerName(() => {
  socket.emit("room:create", data, result => {
    if (!result?.ok) {
      showMessage($("message"), result?.error || "Creation failed.");
      return;
    }

    location.href = `/room?id=${encodeURIComponent(result.roomId)}`;
  });
});

});
}

const joinPage = location.pathname === "/join";

if (joinPage) {
registerName();
}

const roomId = new URLSearchParams(location.search).get("id");

if (location.pathname === "/room" && roomId) {
registerName();

socket.on("room:update", room => {
if (room.id !== roomId) return;

$("roomName").textContent = room.name;

$("roomDetails").textContent =
  `${room.game === "paper" ? "Paper.io" : "Snake"} · ` +
  `${room.players.length}/${room.maxPlayers} players · ` +
  `${room.status}`;

const playerList = $("playerList");
playerList.replaceChildren();

for (const player of room.players) {
  const row = document.createElement("div");
  row.className = "player-row";

  row.textContent =
    player.name +
    (player.isOwner ? " · Room Owner" : "") +
    (player.ready ? " · Ready" : "");

  playerList.appendChild(row);
}

$("startButton").disabled =
  room.ownerId !== socket.id ||
  room.players.length < 2 ||
  room.status !== "waiting";

});

$("startButton")?.addEventListener("click", () => {
showMessage(
$("roomMessage"),
"Game engines are not connected yet."
);
});

$("leaveButton")?.addEventListener("click", () => {
socket.emit("room:leave", () => {
location.href = "/";
});
});
}
