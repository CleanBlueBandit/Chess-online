/*
 * Game page client.
 *
 * WebSocket endpoint:  /ws/game/<gameId>   (gameId from ?id= or the last path segment)
 *
 * CLIENT -> SERVER
 *   {type:"move", from, to, promotion?, ply, fen}   ply = index of this move (1-based), fen = position after it
 *   {type:"abort"}                                  only valid while fewer than 2 plies have been played
 *   {type:"resign"}
 *   {type:"draw_offer"} | {type:"draw_accept"} | {type:"draw_decline"}
 *   {type:"sync"}                                   ask for a fresh "state"
 *
 * SERVER -> CLIENT
 *   {type:"state", color:"w"|"b"|null, moves:[san...], players:{w:{name,rating},b:{name,rating}},
 *                  clocks:{w:ms,b:ms}, running:bool, drawOffer:"w"|"b"|null, result?, reason?}
 *   {type:"move", ply, san, clocks, running}        broadcast to BOTH players (echo doubles as the ack)
 *   {type:"move_rejected", reason, state}           server says the move is illegal/out of turn; state resets the board
 *   {type:"draw_offered", by:"w"|"b"} | {type:"draw_declined"}
 *   {type:"game_over", result:"1-0"|"0-1"|"1/2-1/2"|"*", reason, clocks?}
 *   {type:"error", message}
 */
import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.0.0/+esm";

const $ = (id) => document.getElementById(id);
const FILES = "abcdefgh";
const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const VS15 = "\uFE0E"; // force text (not emoji) presentation
const gameId =
  new URLSearchParams(location.search).get("id") ||
  location.pathname.split("/").filter(Boolean).pop();

const S = {
  color: null,                      // my side: 'w' | 'b' | null (spectator)
  game: new Chess(),                // live position
  fens: [new Chess().fen()],        // fens[i] = position after i plies
  sans: [],
  lasts: [null],                    // lasts[i] = {from,to} of the move that led to fens[i]
  view: 0,                          // ply being displayed (review mode when < live)
  players: { w: { name: "White" }, b: { name: "Black" } },
  clocks: { w: 0, b: 0 }, running: false, tickAt: performance.now(),
  over: false, pending: null,       // pending = optimistic move awaiting server echo
  selected: null, targets: new Map(),
  drawOffer: null,
};

const board = $("board");
const sqEls = new Map();
const live = () => S.view === S.fens.length - 1;
const wsOpen = () => ws?.readyState === WebSocket.OPEN;

/* ---------------- Board ---------------- */
function buildBoard() {
  const flip = S.color === "b";
  board.replaceChildren();
  sqEls.clear();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const file = flip ? 7 - f : f;
      const rank = flip ? r : 7 - r;
      const sq = FILES[file] + (rank + 1);
      const el = document.createElement("div");
      el.className = "square" + ((file + rank) % 2 === 0 ? " dark" : "");
      el.dataset.sq = sq;
      el.setAttribute("role", "gridcell");
      if (r === 7) el.append(coord("file", FILES[file]));
      if (f === 0) el.append(coord("rank", rank + 1));
      board.append(el);
      sqEls.set(sq, el);
    }
  }
}
function coord(kind, text) {
  const c = document.createElement("span");
  c.className = `coord ${kind}`;
  c.textContent = text;
  return c;
}

function renderBoard() {
  const pos = new Chess(S.fens[S.view]);
  const last = S.lasts[S.view];
  const isLive = live();
  let checkSq = null;
  if (pos.inCheck()) {
    checkSq = pos.board().flat().find((p) => p && p.type === "k" && p.color === pos.turn())?.square;
  }
  for (const [sq, el] of sqEls) {
    const t = isLive ? S.targets.get(sq) : null;
    const isCapture = !!t && (!!pos.get(sq) || t.flags.includes("e"));
    el.classList.toggle("last-move", !!last && (last.from === sq || last.to === sq));
    el.classList.toggle("selected", isLive && S.selected === sq);
    el.classList.toggle("legal", !!t);
    el.classList.toggle("capture", isCapture);
    el.classList.toggle("check", sq === checkSq);

    const p = pos.get(sq);
    let pe = el.querySelector(".piece");
    if (p) {
      if (!pe) {
        pe = document.createElement("div");
        pe.className = "piece";
        el.append(pe);
      }
      pe.textContent = GLYPH[p.type] + VS15;
      pe.dataset.color = p.color;
      pe.dataset.own = p.color === S.color ? "1" : "0";
    } else if (pe) {
      pe.remove();
    }
  }
}

/* ---------------- Selection, click and drag ---------------- */
const canMove = () =>
  !S.over && !!S.color && S.game.turn() === S.color && live() && !S.pending && wsOpen();

function select(sq) {
  S.selected = sq;
  S.targets = new Map(S.game.moves({ square: sq, verbose: true }).map((m) => [m.to, m]));
}
function clearSel() {
  S.selected = null;
  S.targets = new Map();
}

let drag = null;
board.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const el = e.target.closest(".square");
  if (!el) return;
  const sq = el.dataset.sq;

  if (S.selected && S.targets.has(sq)) return attemptMove(S.selected, sq);

  if (canMove() && S.game.get(sq)?.color === S.color) {
    select(sq);
    renderBoard();
    drag = { from: sq, pe: el.querySelector(".piece"), ghost: null, x: e.clientX, y: e.clientY, started: false };
    board.setPointerCapture(e.pointerId);
  } else {
    clearSel();
    renderBoard();
  }
});

board.addEventListener("pointermove", (e) => {
  if (!drag) return;
  if (!drag.started) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
    drag.started = true;
    const size = drag.pe.getBoundingClientRect().width;
    const g = drag.pe.cloneNode(true);
    Object.assign(g.style, {
      position: "fixed", width: size + "px", height: size + "px", fontSize: size * 0.82 + "px",
      pointerEvents: "none", zIndex: 30, cursor: "grabbing",
    });
    g.dataset.size = size;
    document.body.append(g);
    drag.ghost = g;
    drag.pe.style.opacity = ".35";
  }
  const s = +drag.ghost.dataset.size;
  drag.ghost.style.left = e.clientX - s / 2 + "px";
  drag.ghost.style.top = e.clientY - s / 2 + "px";
});

const endDrag = (e, drop) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  d.ghost?.remove();
  if (d.pe) d.pe.style.opacity = "";
  if (!drop || !d.started) return;
  const to = document.elementFromPoint(e.clientX, e.clientY)?.closest(".square")?.dataset.sq;
  if (to && to !== d.from && S.targets.has(to)) attemptMove(d.from, to);
};
board.addEventListener("pointerup", (e) => endDrag(e, true));
board.addEventListener("pointercancel", (e) => endDrag(e, false));

/* ---------------- Making a move (validated locally, then sent) ---------------- */
function attemptMove(from, to) {
  const m = S.targets.get(to);
  if (!m || !canMove()) return;
  if (m.promotion) askPromotion((p) => submitMove(from, to, p));
  else submitMove(from, to);
}

function askPromotion(cb) {
  const wrap = $("promo-choices");
  wrap.replaceChildren();
  for (const p of "qrbn") {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = GLYPH[p] + VS15;
    b.style.color = S.color === "w" ? "#fff" : "#1a1a1a";
    b.style.textShadow = S.color === "w" ? "0 0 2px #000, 0 0 2px #000" : "none";
    b.setAttribute("aria-label", { q: "Queen", r: "Rook", b: "Bishop", n: "Knight" }[p]);
    b.onclick = () => { $("promo").hidden = true; cb(p); };
    wrap.append(b);
  }
  $("promo").hidden = false;
}
$("promo").addEventListener("pointerdown", (e) => {
  if (e.target === $("promo")) $("promo").hidden = true; // click outside cancels
});

function submitMove(from, to, promotion) {
  bakeClock();
  let mv;
  try {
    mv = S.game.move({ from, to, promotion });
  } catch {
    clearSel();
    return renderAll();
  }
  S.fens.push(S.game.fen());
  S.sans.push(mv.san);
  S.lasts.push({ from: mv.from, to: mv.to });
  S.view = S.fens.length - 1;
  S.pending = { ply: S.sans.length };
  clearSel();
  send({ type: "move", from, to, promotion, ply: S.sans.length, fen: S.game.fen() });
  renderAll();
}

/* ---------------- State helpers ---------------- */
function rebuild(sans) {
  S.game = new Chess();
  S.fens = [S.game.fen()];
  S.lasts = [null];
  S.sans = [];
  for (const san of sans) pushSan(san);
  S.view = S.fens.length - 1;
}
function pushSan(san) {
  const mv = S.game.move(san); // throws if illegal -> caller resyncs
  S.sans.push(mv.san);
  S.fens.push(S.game.fen());
  S.lasts.push({ from: mv.from, to: mv.to });
}
function setClocks(c, running) {
  if (c) S.clocks = { w: c.w, b: c.b };
  if (typeof running === "boolean") S.running = running;
  S.tickAt = performance.now();
}
function bakeClock() {
  const now = performance.now();
  if (S.running && !S.over) {
    const t = S.game.turn();
    S.clocks[t] = Math.max(0, S.clocks[t] - (now - S.tickAt));
  }
  S.tickAt = now;
}

function applyState(st) {
  if (st.color !== undefined && st.color !== S.color) {
    S.color = st.color;
    buildBoard();
  }
  if (st.players) S.players = st.players;
  try { rebuild(st.moves || []); } catch { rebuild([]); }
  S.pending = null;
  S.drawOffer = st.drawOffer ?? null;
  clearSel();
  $("promo").hidden = true;
  setClocks(st.clocks, st.running);
  if (st.result) endGame(st.result, st.reason);
  else { S.over = false; $("result").hidden = true; }
  renderAll();
}

function endGame(result, reason) {
  S.over = true;
  S.running = false;
  S.drawOffer = null;
  clearSel();
  const who = result === "1-0" ? "White wins" : result === "0-1" ? "Black wins" : null;
  const el = $("result");
  el.textContent =
    result === "*" || reason === "aborted" ? "Game aborted."
    : who ? `${who} by ${reason}.`
    : `Draw by ${reason}.`;
  el.hidden = false;
}

/* ---------------- Server messages ---------------- */
const handlers = {
  state: applyState,

  move(m) {
    if (m.ply <= S.sans.length) {            // echo of my own move: confirmed
      S.pending = null;
      setClocks(m.clocks, m.running);
      return renderAll();
    }
    bakeClock();
    try { pushSan(m.san); } catch { return send({ type: "sync" }); }
    S.drawOffer = null;                       // a move implicitly declines a pending offer
    S.view = S.fens.length - 1;
    clearSel();
    setClocks(m.clocks, m.running);
    renderAll();
  },

  move_rejected(m) {                          // server says no: roll back to its position
    notify(m.reason || "That move isn't allowed.");
    applyState(m.state);
  },

  draw_offered(m) { S.drawOffer = m.by; renderActions(); },
  draw_declined() { S.drawOffer = null; notify("Draw declined."); renderActions(); },

  game_over(m) {
    if (m.clocks) setClocks(m.clocks, false);
    endGame(m.result, m.reason);
    renderAll();
  },

  error(m) { notify(m.message || "Something went wrong."); },
};

/* ---------------- WebSocket ---------------- */
let ws, retry = 0;
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/game/${encodeURIComponent(gameId)}`);
  ws.onopen = () => { retry = 0; $("conn").hidden = true; };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    handlers[m.type]?.(m);
  };
  ws.onclose = () => {
    if (S.over) return;
    $("conn").hidden = false;
    setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000)); // server resends "state" on reconnect
  };
}
function send(obj) {
  if (!wsOpen()) { notify("Connection lost. Reconnecting…"); return false; }
  ws.send(JSON.stringify(obj));
  return true;
}

/* ---------------- Actions: abort / resign / draw ---------------- */
let resignTimer;
$("btn-abort").onclick = () => { if (S.sans.length < 2) send({ type: "abort" }); };
$("btn-resign").onclick = (e) => {
  const b = e.currentTarget;
  if (b.dataset.armed) { clearTimeout(resignTimer); delete b.dataset.armed; b.textContent = "Resign"; return send({ type: "resign" }); }
  b.dataset.armed = "1";
  b.textContent = "Confirm resign";
  resignTimer = setTimeout(() => { delete b.dataset.armed; b.textContent = "Resign"; }, 3000);
};
$("btn-draw").onclick = () => { if (!S.drawOffer && send({ type: "draw_offer" })) { S.drawOffer = S.color; renderActions(); } };
$("draw-accept").onclick = () => send({ type: "draw_accept" });
$("draw-decline").onclick = () => { send({ type: "draw_decline" }); S.drawOffer = null; renderActions(); };

function renderActions() {
  const playing = !!S.color && !S.over;
  const early = S.sans.length < 2;
  $("btn-abort").hidden = !(playing && early);
  $("btn-resign").hidden = !(playing && !early);
  $("btn-draw").hidden = !(playing && !early);
  const mine = S.drawOffer === S.color;
  $("btn-draw").disabled = mine;
  $("btn-draw").textContent = mine ? "Draw offered" : "Offer draw";
  $("draw-prompt").hidden = !(playing && S.drawOffer && !mine);
}

/* ---------------- Moves list, players, clocks ---------------- */
function renderMoves() {
  const list = $("moves");
  list.replaceChildren();
  for (let i = 0; i < S.sans.length; i += 2) {
    const row = document.createElement("div");
    row.className = "move-row";
    const n = document.createElement("span");
    n.className = "move-num";
    n.textContent = i / 2 + 1 + ".";
    row.append(n);
    for (const ply of [i + 1, i + 2]) {
      const san = S.sans[ply - 1];
      const m = document.createElement("span");
      if (san) {
        m.className = "move" + (ply === S.view ? " current" : "");
        m.textContent = san;
        m.onclick = () => { S.view = ply; renderAll(); };
      }
      row.append(m);
    }
    list.append(row);
  }
  list.scrollTop = list.scrollHeight;
}

function renderPlayers() {
  const bottom = S.color || "w";
  const top = bottom === "w" ? "b" : "w";
  for (const [pos, side] of [["top", top], ["bottom", bottom]]) {
    const p = S.players[side] || {};
    $("name-" + pos).textContent = p.name || (side === "w" ? "White" : "Black");
    $("rating-" + pos).textContent = p.rating ? `(${p.rating})` : "";
  }
}

const fmt = (ms) => {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return s < 10 ? `${m}:${sec.toFixed(1).padStart(4, "0")}` : `${m}:${String(Math.floor(sec)).padStart(2, "0")}`;
};
function renderClocks() {
  const now = performance.now();
  const bottom = S.color || "w";
  for (const [pos, side] of [["top", bottom === "w" ? "b" : "w"], ["bottom", bottom]]) {
    const active = S.running && !S.over && S.game.turn() === side;
    const ms = S.clocks[side] - (active ? now - S.tickAt : 0);
    const el = $("clock-" + pos);
    el.textContent = fmt(ms);
    el.classList.toggle("active", active);
    el.classList.toggle("low", active && ms < 20000);
  }
}
setInterval(renderClocks, 100);

let noticeTimer;
function notify(text) {
  const el = $("notice");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (el.hidden = true), 4000);
}

function renderAll() {
  renderBoard();
  renderMoves();
  renderPlayers();
  renderActions();
  renderClocks();
}

/* Review with the arrow keys; End returns to the live position */
addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") S.view = Math.max(0, S.view - 1);
  else if (e.key === "ArrowRight") S.view = Math.min(S.fens.length - 1, S.view + 1);
  else if (e.key === "End") S.view = S.fens.length - 1;
  else return;
  renderAll();
});

buildBoard();
renderAll();
connect();