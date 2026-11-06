// Everything that depends on which machine and network the server is running on. Interface
// addresses are read when needed, not once at startup, because a laptop can change networks.

import { isIPv4 } from 'node:net';
import os from 'node:os';

const VIRTUAL_ADAPTER = /^(utun|bridge|vmnet|docker|awdl|llw)/;
// Strict on purpose: a URL parser would read "evil.example@localhost:3000" as localhost.
const HOST_HEADER = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::(\d{1,5}))?$/;

export function isLoopback(address = '') {
  const ip = address.replace(/^::ffff:/i, '');
  return ip === '::1' || ip.startsWith('127.');
}

function isPrivateIPv4(address) {
  if (!isIPv4(address)) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function adapterRank(name) {
  if (name === 'en0') return 0;
  return name.startsWith('en') ? 1 : 2;
}

// Private IPv4 addresses a phone could reach, best first.
export function lanAddresses(interfaces = os.networkInterfaces()) {
  return Object.entries(interfaces)
    .filter(([name]) => !VIRTUAL_ADAPTER.test(name))
    .sort(([a], [b]) => adapterRank(a) - adapterRank(b))
    .flatMap(([, entries]) => entries)
    .filter(({ address, internal }) => !internal && isPrivateIPv4(address))
    .map(({ address }) => address);
}

export function phoneAddresses(interfaces) {
  const addresses = lanAddresses(interfaces);
  return addresses.length > 0 ? addresses : ['localhost'];
}

export function phoneUrl(address, port, code) {
  return `http://${address}:${port}/dealer#${code}`;
}

export function localNames(hostname = os.hostname(), interfaces = os.networkInterfaces()) {
  const machine = hostname.toLowerCase();
  const [short] = machine.split('.');
  const addresses = Object.values(interfaces).flat().map(({ address }) => address.toLowerCase());
  return new Set(['localhost', '127.0.0.1', '::1', machine, short, `${short}.local`, ...addresses]);
}

function parseHost(header) {
  const [, name, port] = HOST_HEADER.exec(header?.toLowerCase() ?? '') ?? [];
  if (name === undefined) return null;
  return { hostname: name.replace(/^\[|\]$/g, ''), port: port === undefined ? 80 : Number(port) };
}

// A page on a rebound domain reaches this server with the attacker's name in Host. The Origin
// check can't catch that, because Origin and Host agree, so upgrades need this check too.
// Hosted, there is one public name, and the proxy in front decides the port people see.
export function isAllowedHost(header, port, names = localNames(), publicHost = null) {
  if (publicHost !== null) return header?.toLowerCase() === publicHost;
  const host = parseHost(header);
  return host !== null && host.port === port && names.has(host.hostname);
}

export function isSameOrigin(origin, hostHeader) {
  if (origin === undefined) return true;
  if (!URL.canParse(origin)) return false;
  const from = parseHost(new URL(origin).host);
  const to = parseHost(hostHeader);
  return from !== null && to !== null && from.hostname === to.hostname && from.port === to.port;
}

// The HTTP status to refuse a WebSocket upgrade with, or null to accept it.
export function upgradeRefusal({ url, headers }, port, publicHost = null) {
  if (url.split('?')[0] !== '/ws') return 404;
  const isAllowed = isAllowedHost(headers.host, port, undefined, publicHost);
  const allowed = isAllowed && isSameOrigin(headers.origin, headers.host);
  return allowed ? null : 403;
}
