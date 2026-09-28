// Decides where local (username + password) accounts may sign in.
//
// A request counts as coming from the local network only if the connecting address AND
// every client address forwarded by proxies (X-Forwarded-For, X-Real-IP, Forwarded) is
// inside LOCAL_NETWORKS. Anything public or unparseable in the chain makes it "outside".
// This fails closed even when TRUST_PROXY is misconfigured, because a reverse proxy
// that relays an internet client always adds that client's public address.
//
// A request counts as "via the public URL" if its Host (or a forwarded host) is the host
// of an https APP_URL — i.e. it arrived through the domain name exposed by the reverse proxy.

import { BlockList, isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import type { Config } from './config.ts';

export interface AccessInfo {
  /** Connecting address first, then forwarded client addresses as received. */
  addresses: string[];
  local: boolean;
  viaPublicUrl: boolean;
  /** HTTPS as seen by the browser (decides the session cookie flavour). */
  secure: boolean;
  localLoginAllowed: boolean;
}

/** Strips brackets, ports, IPv6 zone ids and IPv4-mapped prefixes. Returns null if not an IP. */
export function normalizeIp(raw: string): string | null {
  let v = raw.trim().replace(/^"|"$/g, '');
  if (!v) return null;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (bracketed) v = bracketed[1]!;
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(':'));
  v = v.replace(/%.*$/, '');
  if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(v)) v = v.slice(7);
  return isIP(v) ? v.toLowerCase() : null;
}

function normalizeHost(raw: string): string {
  const v = raw.trim().replace(/^"|"$/g, '').toLowerCase();
  if (v.startsWith('[')) return v.slice(0, v.indexOf(']') + 1);
  return v.replace(/:\d+$/, '');
}

const headerList = (h: string | string[] | undefined): string[] =>
  (Array.isArray(h) ? h : h ? [h] : []).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);

/** Values of one parameter (for= / host=) from RFC 7239 Forwarded headers. */
function forwardedParams(h: string | string[] | undefined, name: 'for' | 'host'): string[] {
  const out: string[] = [];
  for (const element of headerList(h)) {
    for (const pair of element.split(';')) {
      const [k, v] = pair.split('=');
      if (k?.trim().toLowerCase() === name && v !== undefined) out.push(v.trim());
    }
  }
  return out;
}

export class AccessPolicy {
  private readonly networks = new BlockList();
  private readonly publicHost: string | null;
  readonly mode: Config['LOCAL_LOGIN'];
  readonly networkList: string[];

  constructor(config: Pick<Config, 'LOCAL_LOGIN' | 'LOCAL_NETWORKS' | 'APP_URL'>) {
    this.mode = config.LOCAL_LOGIN;
    this.networkList = config.LOCAL_NETWORKS.split(',').map((s) => s.trim()).filter(Boolean);
    for (const entry of this.networkList) {
      const [addr, prefixRaw] = entry.split('/');
      const ip = addr ? normalizeIp(addr) : null;
      if (!ip) throw new Error(`LOCAL_NETWORKS: invalid address "${entry}"`);
      const type = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
      const max = type === 'ipv6' ? 128 : 32;
      const prefix = prefixRaw === undefined ? max : Number(prefixRaw);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) throw new Error(`LOCAL_NETWORKS: invalid prefix "${entry}"`);
      this.networks.addSubnet(ip, prefix, type);
    }
    const url = new URL(config.APP_URL);
    // Only an https APP_URL is treated as the public domain; an http APP_URL means a LAN-only install.
    this.publicHost = url.protocol === 'https:' ? normalizeHost(url.host) : null;
  }

  isLocalAddress(raw: string): boolean {
    const ip = normalizeIp(raw);
    if (!ip) return false;
    return this.networks.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
  }

  evaluate(request: FastifyRequest): AccessInfo {
    const h = request.headers;
    const addresses = [
      request.socket.remoteAddress ?? '',
      ...headerList(h['x-forwarded-for']),
      ...headerList(h['x-real-ip']),
      ...forwardedParams(h.forwarded, 'for'),
    ];
    const local = addresses.length > 0 && addresses.every((a) => this.isLocalAddress(a));

    const hosts = [...headerList(h.host), ...headerList(h['x-forwarded-host']), ...forwardedParams(h.forwarded, 'host')].map(normalizeHost);
    const viaPublicUrl = this.publicHost !== null && hosts.includes(this.publicHost);
    const secure = viaPublicUrl || request.protocol === 'https';

    let localLoginAllowed = false;
    if (this.mode === 'everywhere') localLoginAllowed = true;
    else if (this.mode === 'local-network') localLoginAllowed = local && !viaPublicUrl;

    return { addresses, local, viaPublicUrl, secure, localLoginAllowed };
  }
}
