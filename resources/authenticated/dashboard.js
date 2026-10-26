const findButton = document.getElementById('find-match');
const cancelButton = document.getElementById('cancel-match');
const searchStatus = document.getElementById('search-status');
const searchStatusText = document.getElementById('search-status-text');
const message = document.getElementById('message');

const gameUrl = (id) => `/games/game/${encodeURIComponent(id)}`;

const socket = io();
let redirecting = false;

function showStatus(text) {
  searchStatusText.textContent = text;
  searchStatus.classList.remove('hidden');
}

function showSearching() {
  findButton.classList.add('hidden');
  cancelButton.classList.remove('hidden');
  cancelButton.disabled = false;
  showStatus('Searching for opponent...');
}

function showIdle() {
  searchStatus.classList.add('hidden');
  cancelButton.classList.add('hidden');
  findButton.classList.remove('hidden');
  findButton.disabled = false;
}

function showError(text) {
  showIdle();
  message.textContent = text;
}

// Both the HTTP response and the socket event can fire for the same match,
// so only the first one navigates.
function goToGame(gameId, text) {
  if (redirecting) return;
  redirecting = true;
  cancelButton.classList.add('hidden');
  findButton.classList.remove('hidden');
  findButton.disabled = true;
  message.textContent = '';
  showStatus(text);
  window.location.href = gameUrl(gameId);
}

socket.on('match_found', ({ gameId }) => {
  goToGame(gameId, 'Match found. Joining game...');
});

socket.on('connect_error', (err) => {
  if (err.message === 'Unauthorized') {
    window.location.href = '/login';
  }
});

findButton.addEventListener('click', async () => {
  message.textContent = '';
  findButton.disabled = true;
  showStatus('Finding a game...');

  try {
    const res = await fetch('/games/start', { method: 'POST' });

    if (res.status === 401) {
      window.location.href = '/login';
      return;
    }

    const data = await res.json().catch(() => null);

    if (!data || !data.ok) {
      showError((data && data.message) || 'Something went wrong. Please try again.');
      return;
    }

    // "Match found." and "You are already in a game." (active) both mean
    // there is a game to join right now.
    if (data.game.state === 'active') {
      goToGame(data.game.id, `${data.message} Joining game...`);
    } else {
      // New waiting game, or the player's own waiting game from earlier.
      // match_found will arrive over the socket when an opponent joins.
      showSearching();
    }
  } catch (err) {
    showError('Could not reach the server.');
  }
});

cancelButton.addEventListener('click', async () => {
  message.textContent = '';
  cancelButton.disabled = true;

  try {
    const res = await fetch('/games/cancel', { method: 'POST' });

    if (res.status === 401) {
      window.location.href = '/login';
      return;
    }

    const data = await res.json().catch(() => null);

    // An opponent joined just before the cancel went through.
    if (res.status === 409 && data && data.game && data.game.state === 'active') {
      goToGame(data.game.id, 'Match found. Joining game...');
      return;
    }

    if (!data || !data.ok) {
      message.textContent = (data && data.message) || 'Something went wrong. Please try again.';
      cancelButton.disabled = false;
      return;
    }

    showIdle();
  } catch (err) {
    message.textContent = 'Could not reach the server.';
    cancelButton.disabled = false;
  }
});