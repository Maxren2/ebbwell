// Partner sharing: the owner creates a single-use invite link (valid 7 days) with chosen
// scopes. Another user of the same instance accepts it and gets a read-only, filtered
// view computed on the server. Either side can end the share at any time.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addDays, diffDays, fromEpochDay } from '../shared/dates.ts';
import { analyze } from '../shared/engine.ts';
import { SHARE_SCOPES, buildPartnerView, type ShareScope } from '../shared/partner.ts';
import { isoDate } from '../shared/schema.ts';
import type { Config } from './config.ts';
import { randomToken, sha256 } from './crypto.ts';
import type { Store } from './db.ts';

const INVITE_TTL_MS = 7 * 86_400_000;
const MAX_ACTIVE_INVITES = 5;
const scopesSchema = z.array(z.enum(SHARE_SCOPES)).max(SHARE_SCOPES.length).transform((s) => [...new Set(s)] as ShareScope[]);
const codeSchema = z.object({ code: z.string().min(10).max(64) });

export function registerSharingRoutes(app: FastifyInstance, deps: { config: Config; store: Store }) {
  const { config, store } = deps;
  const inviteLimit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  const firstName = (id: string) => store.getUser(id)?.name.split(' ')[0] ?? 'Someone';

  app.get('/api/shares', async (request) => {
    const me = request.user!.id;
    return {
      asOwner: store.sharesAsOwner(me).map((s) => ({ id: s.id, name: firstName(s.partnerId), scopes: s.scopes, createdAt: s.createdAt })),
      asPartner: store.sharesAsPartner(me).map((s) => ({ id: s.id, name: firstName(s.ownerId), scopes: s.scopes, createdAt: s.createdAt })),
      invites: store.listInvites(me).map((i) => ({ id: i.id.slice(0, 16), scopes: i.scopes, expiresAt: i.expiresAt })),
    };
  });

  app.post('/api/shares/invites', inviteLimit, async (request, reply) => {
    const body = z.object({ scopes: scopesSchema }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    const me = request.user!.id;
    if (store.listInvites(me).length >= MAX_ACTIVE_INVITES) return reply.code(409).send({ error: 'too-many-invites' });
    // The code travels in the URL fragment, so it never reaches server or proxy logs.
    const code = randomToken(18);
    const expiresAt = Date.now() + INVITE_TTL_MS;
    store.createInvite(sha256(code), me, body.data.scopes, expiresAt);
    store.audit(me, 'share-invite-created');
    return { code, url: `${config.APP_URL}/invite#${code}`, expiresAt };
  });

  app.delete<{ Params: { id: string } }>('/api/shares/invites/:id', async (request, reply) => {
    const me = request.user!.id;
    const match = store.listInvites(me).find((i) => i.id.slice(0, 16) === request.params.id);
    if (match) store.deleteInvite(match.id, me);
    return reply.code(204).send();
  });

  const findInvite = (code: string) => {
    const invite = store.getInvite(sha256(code));
    return invite && invite.expiresAt > Date.now() ? invite : null;
  };

  app.post('/api/shares/invites/preview', inviteLimit, async (request, reply) => {
    const body = codeSchema.safeParse(request.body);
    const invite = body.success ? findInvite(body.data.code) : null;
    if (!invite) return reply.code(404).send({ error: 'invalid-invite' });
    return {
      name: firstName(invite.ownerId),
      scopes: invite.scopes,
      expiresAt: invite.expiresAt,
      own: invite.ownerId === request.user!.id,
    };
  });

  app.post('/api/shares/accept', inviteLimit, async (request, reply) => {
    const body = codeSchema.safeParse(request.body);
    const invite = body.success ? findInvite(body.data.code) : null;
    if (!invite) return reply.code(404).send({ error: 'invalid-invite' });
    const me = request.user!.id;
    if (invite.ownerId === me) return reply.code(400).send({ error: 'own-invite' });
    const share = store.tx(() => {
      store.deleteInvite(invite.id);
      return store.createShare(invite.ownerId, me, invite.scopes);
    });
    store.audit(me, 'share-accepted');
    store.audit(invite.ownerId, 'share-started');
    return { id: share.id };
  });

  app.put<{ Params: { id: string } }>('/api/shares/:id', async (request, reply) => {
    const body = z.object({ scopes: scopesSchema }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    if (!store.updateShareScopes(request.params.id, request.user!.id, body.data.scopes)) return reply.code(404).send({ error: 'not-found' });
    store.audit(request.user!.id, 'share-updated');
    return { scopes: body.data.scopes };
  });

  app.delete<{ Params: { id: string } }>('/api/shares/:id', async (request, reply) => {
    if (store.deleteShare(request.params.id, request.user!.id)) store.audit(request.user!.id, 'share-ended');
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string }; Querystring: { today?: string } }>('/api/shares/:id/view', async (request, reply) => {
    const share = store.getShare(request.params.id);
    // Only the partner may use this view; anything else is indistinguishable from "not found".
    if (!share || share.partnerId !== request.user!.id) return reply.code(404).send({ error: 'not-found' });
    const serverToday = fromEpochDay(Math.floor(Date.now() / 86_400_000));
    const asked = request.query.today;
    const today = asked && isoDate.safeParse(asked).success && Math.abs(diffDays(serverToday, asked)) <= 1 ? asked : serverToday;
    const settings = store.getSettings(share.ownerId);
    const entries = store.listDays(share.ownerId).filter((e) => e.date <= addDays(today, 1));
    const analysis = analyze(entries, settings, today);
    return buildPartnerView(analysis, entries, firstName(share.ownerId), share.scopes, settings.paused || settings.hormonalContraception);
  });
}
