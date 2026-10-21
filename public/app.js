(() => {
  "use strict";

  const socket = io({ reconnection: true, reconnectionAttempts: Infinity });
  const $ = id => document.getElementById(id);
  const NAME_KEY = "arenaPlayerName";
  const PLAYER_KEY = "arenaPlayerKey";
  let sessionReady = false;
  let currentRooms = [];

  function showMessage(element, message, isError = true) {
    if (!element) return;
    element.textContent = message || "";
    element.style.color = isError ? "#ff8f8f" : "";
  }
  function getPlayerName() {
    try { return localStorage.getItem(NAME_KEY) || ""; } catch { return ""; }
  }
  function setPlayerName(name) {
    localStorage.setItem(NAME_KEY, name);
  }
  function getPlayerKey() {
    let key = localStorage.getItem(PLAYER_KEY);
    if (!key) {
      // UUID-shaped key generated locally; server validates its shape.
      key = (crypto.randomUUID ? crypto.randomUUID() :
        "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0;
          return (c === "x" ? r : (r & 3 | 8)).toString(16);
        }));
      localStorage.setItem(PLAYER_KEY, key);
    }
    return key;
  }
  function resumeSession(callback) {
    if (!socket.connected) {
      showMessage($("message"), "Connecting to the game server…");
      return;
    }
    const name = getPlayerName();
    if (!name) {
      sessionReady = true;
      callback?.({ ok: true, noName: true });
      return;
    }
    socket.emit("session:resume", { playerKey: getPlayerKey(), name }, result => {
      sessionReady = Boolean(result?.ok);
      if (!result?.ok) {
        showMessage($("message"), result?.error || "Could not restore player session.");
        return;
      }
      callback?.(result);
    });
  }
  function ensureName(callback) {
    const input = $("playerName");
    const candidate = (input?.value || getPlayerName()).trim();
    if (!candidate) {
      showMessage($("message"), "Enter your player name first.");
      input?.focus();
      return;
    }
    const name = candidate.replace(/\s+/g, " ").slice(0, 20);
    setPlayerName(name);
    if (!socket.connected) {
      showMessage($("message"), "Connecting to the server. Please try again in a moment.");
      return;
    }
    socket.emit("session:resume", { playerKey: getPlayerKey(), name }, result => {
      if (!result?.ok) {
        showMessage($("message"), result?.error || "Could not register your name.");
        return;
      }
      sessionReady = true;
      callback?.(result);
    });
  }
  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }
  function renderRooms(rooms, target) {
    if (!target) return;
    currentRooms = Array.isArray(rooms) ? rooms : [];
    target.replaceChildren();
    if (!currentRooms.length) {
      const empty = document.createElement("p");
      empty.textContent = "No servers available. Create one!";
      target.appendChild(empty);
      return;
    }
    for (const room of currentRooms) {
      const card = document.createElement("article");
      card.className = "server-card";
      const title = document.createElement("h3");
      title.textContent = room.name;
      const details = document.createElement("p");
      details.textContent = `${room.game === "paper" ? "Paper.io" : "Snake"} · ${room.players}/${room.maxPlayers} players · ${room.locked ? "🔒 Password required" : "Public"} · ${room.status}`;
      const button = document.createElement("button");
      button.textContent = "Join Server";
      button.disabled = room.status !== "waiting" || room.players >= room.maxPlayers;
      button.addEventListener("click", () => {
        const name = getPlayerName();
        if (!name) {
          showMessage($("message"), "Enter your player name on the homepage first.");
          location.href = "/";
          return;
        }
        const doJoin = password => ensureName(() => {
          socket.emit("room:join", { roomId: room.id, password }, result => {
            if (!result?.ok) {
              showMessage($("message"), result?.error || "Could not join the server.");
              return;
            }
            location.href = `/room?id=${encodeURIComponent(room.id)}`;
          });
        });
        if (room.locked) {
          const password = window.prompt("Enter the room password");
          if (password === null) return;
          doJoin(password);
        } else doJoin("");
      });
      card.append(title, details, button);
      target.appendChild(card);
    }
  }

  socket.on("connect", () => {
    sessionReady = false;
    resumeSession(() => socket.emit("rooms:list"));
    socket.emit("rooms:list");
  });
  socket.on("connect_error", () => {
    showMessage($("message"), "Can't connect to the game server yet. Please wait and retry.");
  });
  socket.on("rooms:update", rooms => {
    renderRooms(rooms, $("serverList"));
  });

  const nameInput = $("playerName");
  if (nameInput) {
    nameInput.value = getPlayerName();
    $("createButton")?.addEventListener("click", () => {
      ensureName(result => {
        if (result?.ok) location.href = "/create";
      });
    });
    $("joinButton")?.addEventListener("click", () => {
      ensureName(result => {
        if (result?.ok) location.href = "/join";
      });
    });
    $("refreshButton")?.addEventListener("click", () => {
      if (socket.connected) socket.emit("rooms:list");
      else showMessage($("message"), "Connecting to server…");
    });
  }

  const createForm = $("createForm");
  if (createForm) {
    const savedName = getPlayerName();
    if (!savedName) {
      showMessage($("message"), "Please enter your player name on the homepage first.");
    }
    createForm.addEventListener("submit", event => {
      event.preventDefault();
      showMessage($("message"), "");
      if (!socket.connected) return showMessage($("message"), "Not connected to the server. Wait a moment and retry.");
      ensureName(() => {
        const data = {
          name: $("serverName").value.trim(),
          password: $("password").value,
          game: $("game").value,
          maxPlayers: Number($("maxPlayers").value)
        };
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

  if (location.pathname === "/join") {
    if (!getPlayerName()) showMessage($("message"), "Please enter your player name on the homepage first.");
    else resumeSession();
  }

  const roomId = new URLSearchParams(location.search).get("id");
  if (location.pathname === "/room" && roomId) {
    const connectRoom = () => {
      if (!getPlayerName()) {
        location.href = "/";
        return;
      }
      resumeSession(result => {
        if (!result?.ok) return;
        if (result.roomId && result.roomId !== roomId) {
          showMessage($("roomMessage"), "Your saved session belongs to another room.");
          return;
        }
        // session:resume already restores membership and joins the Socket.IO room.
        if (!result.roomId) {
          showMessage($("roomMessage"), "You are not currently in this room. Return home and join it again.");
        }
      });
    };
    socket.on("connect", connectRoom);
    if (socket.connected) connectRoom();

    socket.on("room:update", room => {
      if (room.id !== roomId) return;
      $("roomName").textContent = room.name;
      $("roomDetails").textContent = `${room.game === "paper" ? "Paper.io" : "Snake"} · ${room.players.length}/${room.maxPlayers} players · ${room.status}`;
      const playerList = $("playerList");
      if (!playerList) return;
      playerList.replaceChildren();
      for (const player of room.players) {
        const row = document.createElement("div");
        row.className = "player-row";
        row.textContent = `${player.name}${player.isOwner ? " · Room Owner" : ""}${player.connected ? "" : " · Reconnecting…"}`;
        playerList.appendChild(row);
      }
      const myKey = localStorage.getItem(PLAYER_KEY);
      $("startButton").disabled = room.ownerId !== myKey || room.players.length < 2 || room.status !== "waiting";
      showMessage($("roomMessage"), "", false);
    });
    $("startButton")?.addEventListener("click", () => {
      socket.emit("room:start", result => {
        showMessage($("roomMessage"), result?.ok ? "Starting…" : (result?.error || "Could not start."));
      });
    });
    $("leaveButton")?.addEventListener("click", () => {
      socket.emit("room:leave", () => {
        const key = localStorage.getItem(PLAYER_KEY);
        if (key) {
          // Keep identity and name; next room can be joined normally.
        }
        location.href = "/";
      });
    });
  }
})();