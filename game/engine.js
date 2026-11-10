// No-limit Hold'em betting for a live game. The cards stay on the real table, so this tracks
// only chips and turns. Everything here is pure: state is plain JSON, and applyAction returns
// a new state rather than changing the one it was given.

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 9;

const MAX_NAME_LENGTH = 16;
const DEFAULT_OPTIONS = { startingChips: 1000, smallBlind: 5, bigBlind: 10 };
const STREETS = ['preflop', 'flop', 'turn', 'river'];
const HAND_PHASES = ['betting', 'streetClosed', 'showdown'];

// Keeps every chip count an exact integer, even with all nine stacks in one pot.
const MAX_CHIPS = Math.floor(Number.MAX_SAFE_INTEGER / MAX_PLAYERS);
// Rebuys can put more on the table than a game started with, so the table has its own limit.
const MAX_TABLE_CHIPS = MAX_CHIPS * MAX_PLAYERS;

export class GameError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}

const sum = (values) => values.reduce((total, value) => total + value, 0);
const isLive = (player) => player.status === 'active' || player.status === 'allIn';
const isChipCount = (value) => Number.isInteger(value) && value > 0 && value <= MAX_CHIPS;
const findPlayer = (state, id) => state.players.find((player) => player.id === id);
const actingPlayer = (state) => findPlayer(state, state.actingId);

function requirePlayer(state, id) {
  const player = findPlayer(state, id);
  if (!player) throw new GameError('unknown-player', 'That player is not in the game.');
  return player;
}

// Every player in seat order, starting left of `id` and ending on `id` itself.
function clockwiseFrom(state, id) {
  const { players } = state;
  const start = players.findIndex((player) => player.id === id);
  return players.map((_, i) => players[(start + 1 + i) % players.length]);
}

function createPlayer(id, name, stack) {
  return {
    id,
    name,
    stack,
    bet: 0,
    committed: 0,
    status: 'active',
    lastAction: null,
    payout: 0,
    actedLevel: null, // the bet level when they last acted this street
  };
}

function withoutLastHand(players) {
  return players.map(({ id, name, stack }) => ({
    ...createPlayer(id, name, stack),
    status: stack > 0 ? 'active' : 'out',
  }));
}

function clearedTable() {
  return {
    handNumber: 0,
    street: null,
    nextStreet: null,
    smallBlindId: null,
    bigBlindId: null,
    actingId: null,
    currentBet: 0,
    lastFullRaiseSize: 0,
    result: null,
    gameWinnerId: null,
    tableChips: null, // every chip in play, once a change between hands has moved the total
    lobbyBlinds: null, // the blinds a new game goes back to, once a game has changed them
  };
}

export function createGame() {
  return {
    phase: 'lobby',
    options: { ...DEFAULT_OPTIONS },
    players: [],
    nextPlayerNumber: 1,
    dealerId: null,
    buyIns: {}, // starting stacks that differ from options.startingChips, by player id
    ...clearedTable(),
  };
}

// What a player starts a game with. Saves from before buy-ins have none.
const buyInOf = (state, id) => state.buyIns?.[id] ?? state.options.startingChips;

function cleanName(name, players) {
  const clean = typeof name === 'string' ? name.trim() : '';
  const length = [...clean].length;
  if (length < 1 || length > MAX_NAME_LENGTH) {
    throw new GameError('bad-name', `Names are 1 to ${MAX_NAME_LENGTH} characters.`);
  }
  const lower = clean.toLowerCase();
  if (players.some((player) => player.name.toLowerCase() === lower)) {
    throw new GameError('duplicate-name', 'That name is already taken.');
  }
  return clean;
}

function addPlayer(state, { name }) {
  if (state.players.length >= MAX_PLAYERS) {
    throw new GameError('table-full', `The limit is ${MAX_PLAYERS} players.`);
  }
  const clean = cleanName(name, state.players);
  const id = `p${state.nextPlayerNumber}`;
  state.nextPlayerNumber += 1;
  state.players.push(createPlayer(id, clean, state.options.startingChips));
  state.dealerId ??= id;
}

function removePlayer(state, { id }) {
  requirePlayer(state, id);
  state.players = state.players.filter((player) => player.id !== id);
  delete state.buyIns[id];
  if (state.dealerId === id) state.dealerId = state.players[0]?.id ?? null;
}

function movePlayer(state, { id, direction }) {
  requirePlayer(state, id);
  if (direction !== -1 && direction !== 1) {
    throw new GameError('bad-direction', 'Players move up or down one seat.');
  }
  const from = state.players.findIndex((player) => player.id === id);
  const to = from + direction;
  if (to < 0 || to >= state.players.length) {
    throw new GameError('cannot-move', 'That player cannot move any further.');
  }
  [state.players[from], state.players[to]] = [state.players[to], state.players[from]];
}

function setDealer(state, { id }) {
  state.dealerId = requirePlayer(state, id).id;
}

function setOptions(state, { startingChips, smallBlind, bigBlind }) {
  if (![startingChips, smallBlind, bigBlind].every(isChipCount)) {
    throw new GameError('bad-options', 'Chips and blinds must be whole numbers above zero.');
  }
  if (bigBlind < smallBlind) {
    throw new GameError('bad-options', 'The big blind must be at least the small blind.');
  }
  if (startingChips < bigBlind) {
    throw new GameError('bad-options', 'Starting chips must be at least the big blind.');
  }
  state.options = { startingChips, smallBlind, bigBlind };
  // Someone given their own amount keeps it, unless the default has caught up with it.
  for (const [id, amount] of Object.entries(state.buyIns)) {
    if (amount === startingChips) delete state.buyIns[id];
  }
  for (const player of state.players) player.stack = buyInOf(state, player.id);
}

function setBuyIn(state, { id, stack }) {
  const player = requirePlayer(state, id);
  if (!isChipCount(stack)) {
    throw new GameError('bad-amount', 'Chips must be a whole number above zero.');
  }
  if (stack === player.stack) {
    throw new GameError('no-change', 'They already start with that.');
  }
  if (stack === state.options.startingChips) delete state.buyIns[id];
  else state.buyIns[id] = stack;
  player.stack = stack;
}

function startGame(state) {
  if (state.players.length < MIN_PLAYERS) {
    throw new GameError('not-enough-players', `The game needs at least ${MIN_PLAYERS} players.`);
  }
  startHand(state);
}

function pay(player, amount) {
  player.stack -= amount;
  player.bet += amount;
  player.committed += amount;
  if (player.stack === 0) player.status = 'allIn';
}

function postBlind(player, blind, lastAction) {
  pay(player, Math.min(blind, player.stack));
  player.lastAction = lastAction;
}

function startHand(state) {
  const { smallBlind, bigBlind } = state.options;
  state.phase = 'betting';
  state.handNumber += 1;
  state.street = STREETS[0];
  state.nextStreet = null;
  state.currentBet = bigBlind;
  state.lastFullRaiseSize = bigBlind;
  state.result = null;
  state.players = withoutLastHand(state.players);

  // The list ends on the dealer, who is the small blind when heads up.
  const seated = clockwiseFrom(state, state.dealerId).filter(isLive);
  const [small, big] = seated.length === 2 ? [seated[1], seated[0]] : seated;
  postBlind(small, smallBlind, 'sb');
  postBlind(big, bigBlind, 'bb');
  state.smallBlindId = small.id;
  state.bigBlindId = big.id;
  passAction(state, big.id);
}

// What the player must add to stay in. Zero or less means they owe nothing. Nobody has to match
// more than one opponent can reach: a short big blind leaves currentBet above what is really bet.
function amountToCall(state, player) {
  const others = state.players.filter((other) => other !== player && isLive(other));
  const reach = Math.max(0, ...others.map((other) => other.bet + other.stack));
  return Math.min(player.stack, Math.min(state.currentBet, reach) - player.bet);
}

// Someone else must be able to put in more than the current bet, or raising achieves nothing.
function canBeAnswered(state, player) {
  return state.players.some(
    (other) =>
      other !== player && other.status === 'active' && other.bet + other.stack > state.currentBet,
  );
}

function isOpenTo(state, player) {
  const { actedLevel } = player;
  return actedLevel === null || state.currentBet - actedLevel >= state.lastFullRaiseSize;
}

function legalActions(state, player) {
  const { currentBet, lastFullRaiseSize } = state;
  const owed = Math.max(0, amountToCall(state, player));
  const allInTo = player.bet + player.stack;
  const canGoOver =
    allInTo > currentBet && isOpenTo(state, player) && canBeAnswered(state, player);
  const sizing = (min) => (canGoOver && allInTo >= min ? { min, max: allInTo } : null);
  return {
    fold: true,
    check: owed === 0,
    call: owed,
    bet: currentBet === 0 ? sizing(state.options.bigBlind) : null,
    raise: currentBet > 0 ? sizing(currentBet + lastFullRaiseSize) : null,
    allIn: canGoOver || owed === player.stack ? allInTo : null,
  };
}

function needsTurn(state, player) {
  if (player.status !== 'active') return false;
  if (amountToCall(state, player) > 0) return true;
  if (player.actedLevel !== null) return false;
  return state.players.some((other) => other !== player && other.status === 'active');
}

function passAction(state, fromId) {
  const contested = state.players.filter(isLive).length > 1;
  const next = contested && clockwiseFrom(state, fromId).find((p) => needsTurn(state, p));
  if (next) state.actingId = next.id;
  else closeBetting(state);
}

function returnUncalledBet(state) {
  const [top, second] = [...state.players].sort((a, b) => b.bet - a.bet);
  const excess = top.bet - second.bet;
  if (excess === 0 || top.status === 'folded') return;
  top.stack += excess;
  top.bet -= excess;
  top.committed -= excess;
  if (top.status === 'allIn') top.status = 'active';
  state.currentBet = top.bet;
}

function collectBets(state) {
  for (const player of state.players) {
    player.bet = 0;
    player.actedLevel = null;
  }
  state.currentBet = 0;
  state.lastFullRaiseSize = state.options.bigBlind;
}

function closeBetting(state) {
  returnUncalledBet(state);
  state.actingId = null;
  const handOver = state.street === 'river' || state.players.filter(isLive).length === 1;
  if (handOver) {
    collectBets(state);
    state.phase = 'showdown';
  } else {
    state.phase = 'streetClosed';
    state.nextStreet = STREETS[STREETS.indexOf(state.street) + 1];
  }
}

function dealNextStreet(state) {
  collectBets(state);
  state.street = state.nextStreet;
  state.nextStreet = null;
  state.phase = 'betting';
  for (const player of state.players) {
    if (player.status === 'active') player.lastAction = null;
  }
  passAction(state, state.dealerId);
}

// Every check, call, bet, raise and all in comes through here, so this is the one place the bet
// level changes. An all in below a full raise lifts currentBet but leaves lastFullRaiseSize alone.
function wager(state, player, to, lastAction) {
  const raisedBy = to - state.currentBet;
  if (raisedBy >= state.lastFullRaiseSize) state.lastFullRaiseSize = raisedBy;
  state.currentBet = Math.max(state.currentBet, to);
  pay(player, to - player.bet);
  player.lastAction = player.stack === 0 ? 'allIn' : lastAction;
  player.actedLevel = state.currentBet;
  passAction(state, player.id);
}

function fold(state) {
  const player = actingPlayer(state);
  player.status = 'folded';
  player.lastAction = 'fold';
  passAction(state, player.id);
}

function check(state) {
  const player = actingPlayer(state);
  if (!legalActions(state, player).check) {
    throw new GameError('cannot-check', 'There is a bet to call.');
  }
  wager(state, player, player.bet, 'check');
}

function call(state) {
  const player = actingPlayer(state);
  const owed = legalActions(state, player).call;
  if (owed === 0) throw new GameError('nothing-to-call', 'There is nothing to call.');
  wager(state, player, player.bet + owed, 'call');
}

function requireAmount(range, to) {
  if (!Number.isInteger(to) || to < range.min || to > range.max) {
    throw new GameError('bad-amount', `The amount must be from ${range.min} to ${range.max}.`);
  }
}

function bet(state, { to }) {
  const player = actingPlayer(state);
  const range = legalActions(state, player).bet;
  if (!range) throw new GameError('cannot-bet', 'A bet is not allowed here.');
  requireAmount(range, to);
  wager(state, player, to, 'bet');
}

function raise(state, { to }) {
  const player = actingPlayer(state);
  const range = legalActions(state, player).raise;
  if (!range) throw new GameError('cannot-raise', 'A raise is not allowed here.');
  requireAmount(range, to);
  wager(state, player, to, 'raise');
}

function allIn(state) {
  const player = actingPlayer(state);
  const to = legalActions(state, player).allIn;
  if (to === null) throw new GameError('cannot-all-in', 'All in is not allowed here.');
  wager(state, player, to, 'allIn');
}

// Layers the pot from what each player put in. An active player can still match any level, so
// only all in players set a layer while betting runs, and once it closes the active players sit
// on top with the highest total. That is the same as taking levels from every unfolded total.
// Each layer leaves out at least one player, so no two pots ever share an eligible set.
function buildPots(state) {
  const live = state.players.filter(isLive);
  const levels = live.filter((p) => p.status === 'allIn').map((p) => p.committed);
  if (live.some((p) => p.status === 'active')) levels.push(Infinity);
  const ordered = [...new Set(levels)].sort((a, b) => a - b);

  const pots = [];
  let floor = 0;
  ordered.forEach((level, i) => {
    const ceiling = i === ordered.length - 1 ? Infinity : level;
    const amount = sum(
      state.players.map((p) => Math.max(0, Math.min(p.committed, ceiling) - floor)),
    );
    const eligible = live.filter((p) => p.status === 'active' || p.committed >= level);
    const label = pots.length === 0 ? 'Main pot' : `Side pot ${pots.length}`;
    if (amount > 0) pots.push({ label, amount, eligibleIds: eligible.map((p) => p.id) });
    floor = level;
  });
  return pots;
}

function badAward(message) {
  return new GameError('bad-award', message);
}

function winnersFor({ label, eligibleIds }, picked = []) {
  if (!Array.isArray(picked)) throw badAward(`Pick the winners of the ${label}.`);
  if (picked.length === 0 && eligibleIds.length === 1) return eligibleIds;
  if (picked.length === 0) throw badAward(`Pick a winner for the ${label}.`);
  if (new Set(picked).size !== picked.length || !picked.every((id) => eligibleIds.includes(id))) {
    throw badAward(`Only players still in the ${label} can win it.`);
  }
  return picked;
}

// Equal shares, with odd chips going one at a time from the first winner left of the dealer.
function settlePot(pot, picked, clockwiseIds) {
  const chosen = winnersFor(pot, picked);
  const winnerIds = clockwiseIds.filter((id) => chosen.includes(id));
  const share = Math.floor(pot.amount / winnerIds.length);
  const oddChips = pot.amount % winnerIds.length;
  const shares = Object.fromEntries(
    winnerIds.map((id, i) => [id, share + (i < oddChips ? 1 : 0)]),
  );
  return { label: pot.label, amount: pot.amount, winnerIds, shares };
}

// One player left with chips has won, however they got there.
function decideGame(state, otherwise) {
  const withChips = state.players.filter((player) => player.stack > 0);
  state.phase = withChips.length === 1 ? 'gameOver' : otherwise;
  state.gameWinnerId = withChips.length === 1 ? withChips[0].id : null;
}

function award(state, { pots: picks = [] }) {
  const pots = buildPots(state);
  if (!Array.isArray(picks) || picks.length > pots.length) {
    throw badAward('Pick winners for the pots on the table.');
  }
  const clockwiseIds = clockwiseFrom(state, state.dealerId).map((player) => player.id);
  const settled = pots.map((pot, i) => settlePot(pot, picks[i] ?? [], clockwiseIds));
  state.result = { foldOut: state.players.filter(isLive).length === 1, pots: settled };

  for (const player of state.players) {
    player.payout = sum(settled.map(({ shares }) => shares[player.id] ?? 0));
    player.stack += player.payout;
    if (player.stack === 0) player.status = 'out';
    else if (player.status === 'allIn') player.status = 'active';
  }

  decideGame(state, 'handComplete');
}

// Heads up, the non-dealer posts the big blind. If that would be last hand's big blind again,
// which happens when a dealer busts into heads up, the button moves one seat further instead.
function nextDealer(state) {
  const seated = clockwiseFrom(state, state.dealerId).filter((player) => player.stack > 0);
  const [next, other] = seated;
  return seated.length === 2 && other.id === state.bigBlindId ? other : next;
}

function nextHand(state) {
  state.dealerId = nextDealer(state).id;
  startHand(state);
}

function endGame(state) {
  state.phase = 'lobby';
  state.players = state.players.map(({ id, name }) => createPlayer(id, name, buyInOf(state, id)));
  state.options = { ...state.options, ...state.lobbyBlinds };
  Object.assign(state, clearedTable());
}

// Every change between hands ends here. The last hand's result goes with it, because its winners
// may have left and its payouts no longer explain the stacks. There is no pot between hands, so
// the stacks are all the chips there are.
function reopenTable(state) {
  state.players = withoutLastHand(state.players);
  state.tableChips = sum(state.players.map((player) => player.stack));
  if (state.tableChips === 0) throw new GameError('no-chips', 'Someone has to keep some chips.');
  if (state.tableChips > MAX_TABLE_CHIPS) {
    throw new GameError('too-many-chips', 'That is more chips than the table can count.');
  }
  state.result = null;
  decideGame(state, 'betweenHands');
}

function addChips(state, { id, amount }) {
  const player = requirePlayer(state, id);
  if (!isChipCount(amount)) {
    throw new GameError('bad-amount', 'Chips must be a whole number above zero.');
  }
  player.stack += amount;
  reopenTable(state);
}

function setStack(state, { id, stack }) {
  const player = requirePlayer(state, id);
  if (stack !== 0 && !isChipCount(stack)) {
    throw new GameError('bad-amount', 'A stack must be a whole number of chips.');
  }
  if (stack === player.stack) {
    throw new GameError('no-change', 'That is already their stack.');
  }
  player.stack = stack;
  reopenTable(state);
}

function seatPlayer(state, { name }) {
  addPlayer(state, { name });
  reopenTable(state);
}

// With the dealer gone the chip goes back one seat, which is all it takes for the next hand to
// pass it to whoever sat after them. Their chips leave with them.
function unseatPlayer(state, { id }) {
  requirePlayer(state, id);
  if (state.dealerId === id) state.dealerId = clockwiseFrom(state, id).at(-2)?.id ?? null;
  state.players = state.players.filter((player) => player.id !== id);
  delete state.buyIns[id];
  reopenTable(state);
}

function moveSeat(state, action) {
  movePlayer(state, action);
  reopenTable(state);
}

function setBlinds(state, { smallBlind, bigBlind }) {
  if (![smallBlind, bigBlind].every(isChipCount)) {
    throw new GameError('bad-options', 'Blinds must be whole numbers above zero.');
  }
  if (bigBlind < smallBlind) {
    throw new GameError('bad-options', 'The big blind must be at least the small blind.');
  }
  const { smallBlind: lobbySmall, bigBlind: lobbyBig } = state.options;
  state.lobbyBlinds ??= { smallBlind: lobbySmall, bigBlind: lobbyBig };
  state.options = { ...state.options, smallBlind, bigBlind };
  reopenTable(state);
}

const LOBBY = ['lobby'];
const BETTING = ['betting'];
const BETWEEN_HANDS = ['handComplete', 'betweenHands', 'gameOver'];
const RULES = new Map([
  ['addPlayer', { phases: LOBBY, run: addPlayer }],
  ['removePlayer', { phases: LOBBY, run: removePlayer }],
  ['movePlayer', { phases: LOBBY, run: movePlayer }],
  ['setDealer', { phases: LOBBY, run: setDealer }],
  ['setOptions', { phases: LOBBY, run: setOptions }],
  ['setBuyIn', { phases: LOBBY, run: setBuyIn }],
  ['startGame', { phases: LOBBY, run: startGame }],
  ['fold', { phases: BETTING, run: fold }],
  ['check', { phases: BETTING, run: check }],
  ['call', { phases: BETTING, run: call }],
  ['bet', { phases: BETTING, run: bet }],
  ['raise', { phases: BETTING, run: raise }],
  ['allIn', { phases: BETTING, run: allIn }],
  ['nextStreet', { phases: ['streetClosed'], run: dealNextStreet }],
  ['award', { phases: ['showdown'], run: award }],
  ['nextHand', { phases: ['handComplete', 'betweenHands'], run: nextHand }],
  ['endGame', { phases: [...HAND_PHASES, ...BETWEEN_HANDS], run: endGame }],
  ['addChips', { phases: BETWEEN_HANDS, run: addChips }],
  ['setStack', { phases: BETWEEN_HANDS, run: setStack }],
  ['seatPlayer', { phases: BETWEEN_HANDS, run: seatPlayer }],
  ['unseatPlayer', { phases: BETWEEN_HANDS, run: unseatPlayer }],
  ['moveSeat', { phases: BETWEEN_HANDS, run: moveSeat }],
  ['setBlinds', { phases: BETWEEN_HANDS, run: setBlinds }],
]);

export function applyAction(state, action) {
  const rule = RULES.get(action?.type);
  if (!rule) throw new GameError('unknown-action', 'That action does not exist.');
  if (!rule.phases.includes(state.phase)) {
    throw new GameError('wrong-phase', 'That is not possible right now.');
  }
  // Handlers change this private copy freely. A rejected action just throws it away.
  const next = {
    ...state,
    options: { ...state.options },
    players: state.players.map((player) => ({ ...player })),
    buyIns: { ...state.buyIns },
  };
  rule.run(next, action);
  return next;
}

function potTotals(state) {
  if (!HAND_PHASES.includes(state.phase)) return { total: 0, collected: 0 };
  const total = sum(state.players.map((player) => player.committed));
  return { total, collected: total - sum(state.players.map((player) => player.bet)) };
}

function playerView(player, seat) {
  const { id, name, stack, bet: streetBet, committed, status, lastAction, payout } = player;
  return { id, name, seat, stack, bet: streetBet, committed, status, lastAction, payout };
}

export function toView(state) {
  // A change between hands wipes the last hand off the table, and its blinds with it.
  const showsHand = HAND_PHASES.includes(state.phase) || state.result !== null;
  const canDeal = state.phase === 'handComplete' || state.phase === 'betweenHands';
  return {
    phase: state.phase,
    options: { ...state.options },
    handNumber: state.handNumber,
    street: state.street,
    nextStreet: state.nextStreet,
    dealerId: state.dealerId,
    nextDealerId: canDeal ? nextDealer(state).id : null,
    smallBlindId: showsHand ? state.smallBlindId : null,
    bigBlindId: showsHand ? state.bigBlindId : null,
    actingId: state.actingId,
    currentBet: state.currentBet,
    players: state.players.map(playerView),
    pot: potTotals(state),
    pots: HAND_PHASES.includes(state.phase) ? buildPots(state) : [],
    legal: state.phase === 'betting' ? legalActions(state, actingPlayer(state)) : null,
    result: state.result && structuredClone(state.result),
    gameWinnerId: state.gameWinnerId,
  };
}

// Grouped the same way every screen shows chips.
const chips = (amount) => amount.toLocaleString('en-US');

function wagerTotal(state, player, action) {
  if (action.type === 'call') return player.bet + Math.max(0, amountToCall(state, player));
  if (action.type === 'allIn') return player.bet + player.stack;
  return action.to;
}

function describeWager(state, action) {
  const player = actingPlayer(state);
  if (!player) return 'Unknown action';
  const to = wagerTotal(state, player, action);
  const note = to === player.bet + player.stack ? ', all in' : '';
  if (to <= state.currentBet) return `${player.name} called ${chips(to - player.bet)}${note}`;
  if (state.currentBet === 0) return `${player.name} bet ${chips(to)}${note}`;
  return `${player.name} raised to ${chips(to)}${note}`;
}

function describeAward(state, action) {
  const pots = buildPots(state);
  if (pots.length !== 1) return `Awarded ${pots.length} pots`;
  const [{ amount, eligibleIds }] = pots;
  const winnerIds = eligibleIds.length === 1 ? eligibleIds : action.pots ?? [];
  const names = winnerIds.flat().map((id) => findPlayer(state, id)?.name);
  if (names.length === 1) return `${names[0]} won ${chips(amount)}`;
  return `Split ${chips(amount)} between ${names.join(', ')}`;
}

// `state` is the game as it stood before the action, which is what the text talks about.
export function describeAction(state, action) {
  const nameOf = (id) => findPlayer(state, id)?.name ?? 'Player';
  switch (action.type) {
    case 'addPlayer':
      return `Added ${String(action.name).trim()}`;
    case 'removePlayer':
      return `Removed ${nameOf(action.id)}`;
    case 'movePlayer':
      return `Moved ${nameOf(action.id)} ${action.direction < 0 ? 'up' : 'down'}`;
    case 'setDealer':
      return `${nameOf(action.id)} starts as dealer`;
    case 'setOptions':
      return 'Changed the game options';
    case 'setBuyIn':
      return `${nameOf(action.id)} starts with ${chips(action.stack)}`;
    case 'startGame':
      return 'Started the game';
    case 'fold':
      return `${nameOf(state.actingId)} folded`;
    case 'check':
      return `${nameOf(state.actingId)} checked`;
    case 'call':
    case 'bet':
    case 'raise':
    case 'allIn':
      return describeWager(state, action);
    case 'nextStreet':
      return `Dealt the ${state.nextStreet}`;
    case 'award':
      return describeAward(state, action);
    case 'nextHand':
      return `Started hand ${state.handNumber + 1}`;
    case 'endGame':
      return 'Ended the game';
    case 'addChips': {
      const verb = findPlayer(state, action.id)?.stack === 0 ? 'rebought' : 'added';
      return `${nameOf(action.id)} ${verb} ${chips(action.amount)}`;
    }
    case 'setStack':
      return `${nameOf(action.id)} set to ${chips(action.stack)}`;
    case 'seatPlayer':
      return `Seated ${String(action.name).trim()}`;
    case 'unseatPlayer':
      return `Removed ${nameOf(action.id)}`;
    case 'moveSeat':
      return `Moved ${nameOf(action.id)} ${action.direction < 0 ? 'up' : 'down'}`;
    case 'setBlinds':
      return `Blinds set to ${chips(action.smallBlind)} / ${chips(action.bigBlind)}`;
    default:
      return 'Unknown action';
  }
}
