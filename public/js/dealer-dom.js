// Small helpers for the dealer page. Names and every other value from the game go in as text,
// never as markup.

const SVG_NS = 'http://www.w3.org/2000/svg';
const KEYBOARD_MIN_PX = 120;
const KEYBOARD_SETTLE_MS = 320;
const FIT_PASSES = 4;

const grouped = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

const isContent = (child) => child !== null && child !== undefined && child !== false;

export const $ = (selector) => document.querySelector(selector);
export const chips = (value) => grouped.format(value);
export const shortChips = (value) => (value < 1e9 ? chips(value) : compact.format(value));

export function h(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (typeof value === 'function') node.addEventListener(name, value);
    else if (value === true) node.setAttribute(name, '');
    else if (value !== false && value !== null && value !== undefined) {
      node.setAttribute(name, value);
    }
  }
  node.append(...children.flat().filter(isContent));
  return node;
}

export function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.append(use);
  return svg;
}

// A big button with an optional small line under its label. `off` means the rules forbid it,
// which stays true however the locks change.
export function button({ label, note = null, tone = '', action = null, off = false, tap }) {
  return h(
    'button',
    {
      type: 'button',
      class: `btn ${tone}`,
      'data-lock': true,
      'data-off': off,
      'data-action': action,
      click: tap,
    },
    h('span', { class: 'btn-label', 'data-fit': true }, label),
    note === null ? null : h('span', { class: 'btn-note', 'data-fit': true }, note),
  );
}

// A numeric keypad still lets people paste. The dot stays so the engine refuses 10.5, instead of
// the digits closing up into 105.
export function keepDigits({ target }) {
  target.value = target.value.replace(/[^\d.]/g, '');
}

// More than one pass, because system fonts get relatively wider as they get smaller.
function fit(node) {
  node.style.fontSize = '';
  for (let pass = 0; pass < FIT_PASSES && node.scrollWidth > node.clientWidth; pass += 1) {
    const size = parseFloat(getComputedStyle(node).fontSize);
    node.style.fontSize = `${(size * (node.clientWidth - 1)) / node.scrollWidth}px`;
  }
}

// CSS sets the largest size for each [data-fit] line. Long names and huge stacks shrink to fit
// instead of being cut off.
export function fitText(root = document) {
  root.querySelectorAll('[data-fit]').forEach(fit);
}

// Phones lay the keyboard over the page instead of resizing it. Sizing the page to what is left
// keeps the docked buttons and the raise sheet above the keyboard.
export function trackKeyboard() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const root = document.documentElement;

  function update() {
    const isTyping = document.activeElement?.matches('input') ?? false;
    // innerHeight falls by as much as Safari pans the page up to a low field. Adding the pan back
    // gives the whole page, whichever way up the phone is, so there is no height to remember.
    const covered = window.innerHeight + viewport.offsetTop - viewport.height;
    const open = isTyping && covered > KEYBOARD_MIN_PX && viewport.scale < 1.01;
    // iPhones can leave the page scrolled after the keyboard goes.
    if (!open && root.classList.contains('keyboard-open')) window.scrollTo(0, 0);
    root.classList.toggle('keyboard-open', open);
    root.style.setProperty('--open-height', `${viewport.height}px`);
    root.style.setProperty('--open-top', `${viewport.offsetTop}px`);
  }

  // A busy phone can finish opening the keyboard after the timer below, leaving the field under it.
  function keepFieldInView() {
    if (root.classList.contains('keyboard-open')) {
      document.activeElement.scrollIntoView({ block: 'nearest' });
    }
  }

  viewport.addEventListener('resize', () => {
    update();
    keepFieldInView();
  });
  viewport.addEventListener('scroll', update);
  update();

  document.addEventListener('focusin', ({ target }) => {
    if (!target.matches('input')) return;
    setTimeout(() => target.scrollIntoView({ block: 'nearest' }), KEYBOARD_SETTLE_MS);
  });
}
