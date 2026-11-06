// The Game tab once a hand is running: the strip with the pot, the hero, the list, and the big
// buttons for the phase. All of it is rebuilt from `game` alone. Pot winners picked at showdown
// are the only thing held here, and they last only until the game moves.

import { $, button, chips, h, icon, shortChips } from './dealer-dom.js';

const STREET_NAMES = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' };
const LAST_ACTION_TAGS = { check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise' };
const STATUS_TAGS = { folded: 'Folded', allIn: 'All in', out: 'Out' };
// Reaches the slowest double tap Safari still counts as one.
const PICK_REPEAT_MS = 600;
const PICK_REPEAT_PX = 40;
const NO_TAP = { x: 0, y: 0, at: -Infinity, listMoved: false };
const NBSP = '\u00A0';
const APP_MAX_WIDTH_PX = 560;
const DIGIT_PX = 9;
// Everything in a row that isn't a number, a name at its narrowest included.
const ROW_FIXED_PX = 250;

const playerById = (game, id) => game.players.find((player) => player.id === id);
const namesOf = (game, ids) => ids.map((id) => playerById(game, id).name);
const isContested = (pot) => pot.eligibleIds.length > 1;
const paidOut = ({ result }) => result.pots.reduce((total, { amount }) => total + amount, 0);

// The second half of a double tap lands where the first did, and once the list has moved, a quick
// tap anywhere lands on someone it wasn't aimed at. Any other quick tap is a second winner.
export function isRepeatTap(last, tap) {
  const isSameSpot = Math.hypot(tap.x - last.x, tap.y - last.y) < PICK_REPEAT_PX;
  return tap.at - last.at < PICK_REPEAT_MS && (isSameSpot || last.listMoved);
}

// A fold stops mattering once the hand is over, and this is the list the dealer checks against the
// real chips.
function shownStatus(game, player) {
  return game.phase === 'handComplete' && player.status === 'folded' ? 'active' : player.status;
}

// ALL IN comes from status, never lastAction: a refund can leave lastAction 'allIn' on someone
// who is active with chips back in their stack.
function statusTag(game, player) {
  const fromStatus = STATUS_TAGS[shownStatus(game, player)];
  if (fromStatus) return fromStatus;
  if (game.phase === 'handComplete' || game.phase === 'gameOver') return '';
  if (player.lastAction === 'sb' && player.id === game.dealerId) return 'SB';
  return LAST_ACTION_TAGS[player.lastAction] ?? '';
}

function positionMark(game, player) {
  if (player.id === game.dealerId) return h('span', { class: 'dealer-chip small' }, 'D');
  if (player.id === game.smallBlindId) return h('span', { class: 'blind-mark' }, 'SB');
  if (player.id === game.bigBlindId) return h('span', { class: 'blind-mark' }, 'BB');
  return null;
}

function numberCell(kind, label, text, isWide) {
  return h('span', { class: `num ${kind}`, 'data-fit': isWide, 'data-label': label }, text);
}

function playerRow(game, player, betText, { head, isWide }) {
  const isActing = player.id === game.actingId;
  return h(
    'li',
    {
      class: `row ${shownStatus(game, player)}${isActing ? ' acting' : ''}`,
      'data-player': player.id,
      'aria-current': isActing ? 'true' : null,
    },
    h('span', { class: 'mark' }, positionMark(game, player)),
    h('span', { class: 'who' }, player.name),
    h('span', { class: 'tag' }, statusTag(game, player)),
    h(
      'span',
      { class: 'nums' },
      numberCell('bet', head, betText, isWide),
      numberCell('stack', 'Stack', chips(player.stack), isWide),
    ),
  );
}

function playerList(game, { head = 'Bet', betOf = (p) => (p.bet > 0 ? chips(p.bet) : '') } = {}) {
  const longest = (texts) => Math.max(...texts.map((text) => text.length));
  const bets = game.players.map(betOf);
  const stacks = game.players.map((player) => chips(player.stack));
  const betWidth = longest([head, ...bets]);
  const stackWidth = longest(['Stack', ...stacks]);
  const width = Math.min(document.documentElement.clientWidth, APP_MAX_WIDTH_PX);
  const isWide = (betWidth + stackWidth) * DIGIT_PX > width - ROW_FIXED_PX;

  return h(
    'section',
    {
      class: isWide ? 'players wide' : 'players',
      style: `--bet-ch:${betWidth};--stack-ch:${stackWidth}`,
    },
    h(
      'div',
      { class: 'row head', 'aria-hidden': 'true' },
      h('span', { class: 'mark' }),
      h('span', { class: 'who' }, 'Player'),
      h('span', { class: 'tag' }),
      h(
        'span',
        { class: 'nums' },
        h('span', { class: 'num bet' }, head),
        h('span', { class: 'num stack' }, 'Stack'),
      ),
    ),
    h(
      'ol',
      {},
      game.players.map((player, i) => playerRow(game, player, bets[i], { head, isWide })),
    ),
  );
}

function stat(label, value, name) {
  return h(
    'div',
    { class: 'stat' },
    h('dt', {}, label),
    h('dd', { 'data-fit': true, 'data-stat': name }, value),
  );
}

function hero({ tone = 'quiet', eyebrow = null, title, line = null, stats = null }) {
  return h(
    'div',
    { class: `hero ${tone}` },
    eyebrow === null ? null : h('p', { class: 'hero-eyebrow' }, eyebrow),
    h('p', { class: 'hero-name', 'data-fit': true }, title),
    line === null ? null : h('p', { class: 'hero-line', 'data-fit': true }, line),
    stats === null ? null : h('dl', { class: 'hero-stats' }, stats),
  );
}

function potSummary(game) {
  if (game.pots.length < 2) return null;
  const parts = game.pots.map(({ label, amount }) =>
    `${label} ${chips(amount)}`.replaceAll(' ', NBSP),
  );
  return h('p', { class: 'pots-line' }, parts.join(`${NBSP}· `));
}

function strip({ where, detail, figureLabel, figure }) {
  return [
    h(
      'div',
      { class: 'strip-where' },
      h('p', { class: 'strip-street' }, where),
      h('p', { class: 'strip-detail', 'data-fit': true }, detail),
    ),
    h(
      'div',
      { class: 'strip-pot' },
      h('p', { class: 'strip-label' }, figureLabel),
      h('p', { class: 'strip-figure', 'data-fit': true, 'data-stat': 'pot' }, figure),
    ),
  ];
}

function handDetail({ handNumber, options: { smallBlind, bigBlind } }) {
  return `Hand ${handNumber} · Blinds ${shortChips(smallBlind)}/${shortChips(bigBlind)}`;
}

function liveStrip(game) {
  return strip({
    where: STREET_NAMES[game.street],
    detail: handDetail(game),
    figureLabel: 'Pot',
    figure: chips(game.pot.total),
  });
}

// In handComplete and gameOver the pots are gone, so result and payout tell the story.
function resultCards(game) {
  const cards = game.result.pots.map(({ label, amount, winnerIds, shares }) =>
    h(
      'article',
      { class: 'pot-card' },
      h(
        'header',
        { class: 'pot-head' },
        h('h3', {}, label),
        h('span', { class: 'pot-amount', 'data-fit': true }, chips(amount)),
      ),
      h(
        'ul',
        { class: 'shares' },
        winnerIds.map((id) =>
          h(
            'li',
            {},
            h('span', { class: 'share-name' }, playerById(game, id).name),
            h('span', { class: 'share-amount', 'data-fit': true }, `+${chips(shares[id])}`),
          ),
        ),
      ),
    ),
  );
  return h('section', { class: 'cards' }, cards);
}

// No result means the table changed after the hand, so there is nothing left to report but stacks.
function stacksList(game) {
  return playerList(game, { head: '', betOf: () => '' });
}

function outcomeBody(game) {
  if (game.result === null) return stacksList(game);
  const { pots } = game.result;
  const isSimple = pots.length === 1 && pots[0].winnerIds.length === 1;
  const betOf = ({ payout }) => (payout > 0 ? `+${chips(payout)}` : '');
  return [isSimple ? null : resultCards(game), playerList(game, { head: 'Won', betOf })];
}

export function createTable({ actions, openRaise, openManage, onChange }) {
  const stripNode = $('#strip');
  const heroNode = $('#hero');
  const bodyNode = $('#body');
  const picks = new Map();
  let lastTap = NO_TAP;
  let lastActingId = null;
  let lastPhase = null;

  function actionButtons(game) {
    const { legal } = game;
    const player = playerById(game, game.actingId);
    const callIsWholeStack = legal.call > 0 && legal.call === player.stack;
    const showAllIn = legal.allIn !== null && !callIsWholeStack;
    const range = legal.raise ?? legal.bet;
    const dispatch = (type) => () => actions.dispatch({ type });

    const lower = h(
      'div',
      { class: 'actions lower' },
      button({ label: 'Fold', tone: 'lg fold', action: 'fold', tap: dispatch('fold') }),
      legal.check
        ? button({ label: 'Check', tone: 'lg primary', action: 'check', tap: dispatch('check') })
        : button({
            label: `Call ${chips(legal.call)}`,
            note: callIsWholeStack ? 'All in' : null,
            tone: 'lg primary',
            action: 'call',
            tap: dispatch('call'),
          }),
    );
    if (!range && !showAllIn) return [lower];

    const upper = h(
      'div',
      { class: 'actions upper' },
      button({
        label: 'All in',
        note: showAllIn ? `to ${shortChips(legal.allIn)}` : null,
        tone: 'allin',
        action: 'all-in',
        off: !showAllIn,
        tap: dispatch('allIn'),
      }),
      button({
        label: game.currentBet > 0 ? 'Raise' : 'Bet',
        note: range ? `min ${shortChips(range.min)}` : null,
        tone: 'wager',
        action: 'wager',
        off: !range,
        tap: () => openRaise(game, player),
      }),
    );
    return [upper, lower];
  }

  function betting(game) {
    const player = playerById(game, game.actingId);
    const inFront = player.bet > 0 ? ` · ${chips(player.bet)} in` : '';
    return {
      strip: liveStrip(game),
      hero: hero({
        tone: 'acting',
        eyebrow: `To act${inFront}`,
        title: player.name,
        stats: [
          stat('Stack', chips(player.stack), 'stack'),
          stat('To call', chips(game.legal.call), 'call'),
        ],
      }),
      extra: potSummary(game),
      body: playerList(game),
      primary: actionButtons(game),
    };
  }

  function streetClosed(game) {
    const canBet = game.players.filter((player) => player.status === 'active').length > 1;
    return {
      strip: liveStrip(game),
      hero: hero({
        eyebrow: 'Betting closed',
        title: `${STREET_NAMES[game.nextStreet]} is next`,
        line: canBet ? null : 'No more betting this hand',
      }),
      extra: potSummary(game),
      body: playerList(game),
      primary: [
        button({
          label: `Deal the ${game.nextStreet}`,
          tone: 'lg primary',
          action: 'deal',
          tap: () => actions.dispatch({ type: 'nextStreet' }),
        }),
      ],
    };
  }

  function togglePick(game, index, id, { clientX, clientY }) {
    const tap = { x: clientX, y: clientY, at: performance.now() };
    if (isRepeatTap(lastTap, tap)) return;
    const { scrollTop } = bodyNode;
    const chosen = picks.get(index) ?? new Set();
    if (!chosen.delete(id)) chosen.add(id);
    picks.set(index, chosen);
    onChange();
    revealUnpicked(game);
    lastTap = { ...tap, listMoved: bodyNode.scrollTop !== scrollTop };
  }

  function pickButton(game, index, id) {
    const isPicked = picks.get(index)?.has(id) ?? false;
    return h(
      'button',
      {
        type: 'button',
        class: 'pick',
        'aria-pressed': String(isPicked),
        'data-lock': true,
        'data-pick': id,
        click: (event) => togglePick(game, index, id, event),
      },
      isPicked ? icon('check') : null,
      h('span', { class: 'pick-name' }, playerById(game, id).name),
    );
  }

  function splitNote(pot, index) {
    const winners = picks.get(index)?.size ?? 0;
    if (winners < 2) return null;
    const share = Math.floor(pot.amount / winners);
    const odd = pot.amount % winners;
    const extra = odd === 0 ? '' : `, ${odd} odd ${odd === 1 ? 'chip' : 'chips'}`;
    return h('p', { class: 'split-note', 'data-fit': true }, `Split: ${chips(share)} each${extra}`);
  }

  function potCard(game, pot, index) {
    return h(
      'article',
      { class: isContested(pot) ? 'pot-card' : 'pot-card decided', 'data-pot': index },
      h(
        'header',
        { class: 'pot-head' },
        h('h3', {}, pot.label),
        h('span', { class: 'pot-amount', 'data-fit': true }, chips(pot.amount)),
      ),
      isContested(pot)
        ? h('div', { class: 'picks' }, pot.eligibleIds.map((id) => pickButton(game, index, id)))
        : h('p', { class: 'pot-decided' }, `Goes to ${namesOf(game, pot.eligibleIds)[0]}`),
      splitNote(pot, index),
    );
  }

  function firstUnpicked(game) {
    return game.pots.find((pot, i) => isContested(pot) && !picks.get(i)?.size) ?? null;
  }

  // Award names the pot that still needs a winner, so that pot shouldn't take a swipe to find.
  function revealUnpicked(game) {
    const index = game.pots.indexOf(firstUnpicked(game));
    bodyNode.querySelector(`[data-pot="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function awardAction(game) {
    const pots = game.pots.map((pot, i) => (isContested(pot) ? [...(picks.get(i) ?? [])] : []));
    return { type: 'award', pots };
  }

  function showdown(game) {
    const unpicked = firstUnpicked(game);
    return {
      strip: liveStrip(game),
      hero: game.pots.some(isContested)
        ? hero({
            tone: 'quiet compact',
            title: 'Who won?',
            line: 'Tap the winner. Tap two or more to split.',
          })
        : hero({
            eyebrow: 'Everyone else folded',
            title: namesOf(game, game.pots[0].eligibleIds)[0],
            line: `Wins ${chips(game.pot.total)}`,
          }),
      body: h(
        'section',
        { class: 'cards' },
        game.pots.map((pot, i) => potCard(game, pot, i)),
      ),
      primary: [
        button({
          label: 'Award',
          note: unpicked ? `${unpicked.label} needs a winner` : null,
          tone: 'lg primary',
          action: 'award',
          off: unpicked !== null,
          tap: () => actions.dispatch(awardAction(game)),
        }),
      ],
    };
  }

  function outcomeHero(game) {
    const winners = game.players.filter((player) => player.payout > 0);
    const reason = game.result.foldOut ? ' · Everyone else folded' : '';
    const eyebrow = `Hand ${game.handNumber}${reason}`;
    if (winners.length === 1) {
      return hero({
        tone: 'won',
        eyebrow,
        title: winners[0].name,
        line: `Wins ${chips(winners[0].payout)}`,
      });
    }
    return hero({
      tone: 'won',
      eyebrow,
      title: `${winners.length} winners`,
      line: `${chips(paidOut(game))} paid out`,
    });
  }

  // The same row Fold and Call use, so the screen doesn't lose any height to it.
  function withManage(main) {
    const manage = button({
      label: 'Manage table',
      note: 'Chips, seats, blinds',
      tone: 'lg wager',
      action: 'manage',
      tap: openManage,
    });
    return [h('div', { class: 'actions lower' }, manage, main)];
  }

  function nextHandButton(game) {
    return button({
      label: 'Next hand',
      note: `Dealer chip moves to ${playerById(game, game.nextDealerId).name}`,
      tone: 'lg primary',
      action: 'next-hand',
      tap: () => actions.dispatch({ type: 'nextHand' }),
    });
  }

  function handComplete(game) {
    return {
      strip: strip({
        where: 'Hand over',
        detail: handDetail(game),
        figureLabel: 'Paid',
        figure: chips(paidOut(game)),
      }),
      hero: outcomeHero(game),
      body: outcomeBody(game),
      primary: withManage(nextHandButton(game)),
    };
  }

  function betweenHands(game) {
    const { handNumber, options, players } = game;
    return {
      strip: strip({
        where: 'Between hands',
        detail: `Blinds ${shortChips(options.smallBlind)}/${shortChips(options.bigBlind)}`,
        figureLabel: 'Chips',
        figure: chips(players.reduce((total, { stack }) => total + stack, 0)),
      }),
      hero: hero({
        eyebrow: 'Table updated',
        title: `Hand ${chips(handNumber + 1)} is next`,
      }),
      body: stacksList(game),
      primary: withManage(nextHandButton(game)),
    };
  }

  function gameOver(game) {
    const winner = playerById(game, game.gameWinnerId);
    return {
      strip: strip({
        where: 'Game over',
        detail: `${game.handNumber} ${game.handNumber === 1 ? 'hand' : 'hands'} played`,
        figureLabel: 'Chips',
        figure: chips(winner.stack),
      }),
      hero: hero({
        tone: 'won',
        eyebrow: 'Game over',
        title: winner.name,
        line: 'Wins the game',
      }),
      body: outcomeBody(game),
      primary: withManage(
        button({
          label: 'New game',
          note: 'Same players, stacks reset',
          tone: 'lg primary',
          action: 'new-game',
          tap: () => actions.dispatch({ type: 'endGame' }),
        }),
      ),
    };
  }

  const screens = { betting, streetClosed, showdown, handComplete, betweenHands, gameOver };

  return {
    render(game) {
      const screen = screens[game.phase](game);
      stripNode.replaceChildren(...screen.strip);
      heroNode.replaceChildren(screen.hero);
      screen.hero.classList.toggle('enter', game.actingId !== lastActingId);
      lastActingId = game.actingId;
      $('#pots-line').replaceChildren(...[screen.extra].filter(Boolean));
      const body = [screen.body].flat().filter(Boolean);
      bodyNode.replaceChildren(...body);
      if (game.phase !== lastPhase) bodyNode.scrollTop = 0;
      lastPhase = game.phase;
      bodyNode.querySelector('.acting')?.scrollIntoView({ block: 'nearest' });
      return screen.primary;
    },
    resetPicks() {
      picks.clear();
      lastTap = NO_TAP;
    },
  };
}
