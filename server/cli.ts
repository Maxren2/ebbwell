// Account recovery from the server itself, e.g.:
//   docker exec -it ebbwell node server/cli.ts list-users
//   docker exec -it ebbwell node server/cli.ts reset-password alice
//   docker exec -it ebbwell node server/cli.ts create-user alice "Alice" --admin
//   docker exec -it ebbwell node server/cli.ts set-admin alice on|off
//   docker exec -it ebbwell node server/cli.ts enable alice
//   docker exec -it ebbwell node server/cli.ts disable-2fa alice
import { join } from 'node:path';
import { USERNAME_RE, loadConfig } from './config.ts';
import { Cipher } from './crypto.ts';
import { Store } from './db.ts';
import { hashSecret, temporaryPassword } from './passwords.ts';

const [command, ...args] = process.argv.slice(2);
const config = loadConfig();
const store = new Store(join(config.DATA_DIR, 'ebbwell.sqlite'), new Cipher(config.DATA_ENCRYPTION_KEY, config.DATA_ENCRYPTION_KEY_PREVIOUS));

function localUser(username: string | undefined) {
  const creds = username ? store.findLocalCredentials(username.toLowerCase()) : null;
  if (!creds) throw new Error(`No local account "${username ?? ''}"`);
  return creds.user;
}

try {
  switch (command) {
    case 'list-users':
      for (const u of store.listUsers()) {
        const flags = [u.kind, u.isAdmin && 'admin', u.twoFactor && '2fa', u.disabled && 'disabled', u.lockedUntil > Date.now() && 'locked'].filter(Boolean).join(', ');
        console.log(`${(u.username ?? '-').padEnd(20)} ${u.name.padEnd(24)} ${flags}`);
      }
      break;
    case 'reset-password': {
      const user = localUser(args[0]);
      const password = temporaryPassword();
      store.setPassword(user.id, await hashSecret(password), true);
      store.deleteUserSessions(user.id);
      store.audit(user.id, 'password-reset-cli');
      console.log(`Temporary password for ${user.username}: ${password}\n(it must be changed at the next sign-in)`);
      break;
    }
    case 'create-user': {
      const [username, name, flag] = args;
      if (!username || !USERNAME_RE.test(username)) throw new Error('Usage: create-user <username> [display name] [--admin]');
      if (store.findLocalCredentials(username)) throw new Error(`"${username}" already exists`);
      const password = temporaryPassword();
      store.createLocalUser({
        username,
        name: name && name !== '--admin' ? name : username,
        passwordHash: await hashSecret(password),
        isAdmin: flag === '--admin' || name === '--admin',
        mustChangePassword: true,
      });
      console.log(`Created ${username}. Temporary password: ${password}`);
      break;
    }
    case 'set-admin': {
      const user = localUser(args[0]);
      if (args[1] !== 'on' && args[1] !== 'off') throw new Error('Usage: set-admin <username> on|off');
      store.setAdmin(user.id, args[1] === 'on');
      console.log(`${user.username} is ${args[1] === 'on' ? 'now' : 'no longer'} an administrator`);
      break;
    }
    case 'enable': {
      const user = localUser(args[0]);
      store.setDisabled(user.id, false);
      store.recordLogin(user.id); // also clears a failed-login lock
      console.log(`${user.username} is enabled and unlocked`);
      break;
    }
    case 'disable-2fa': {
      const user = localUser(args[0]);
      store.setTotp(user.id, null);
      store.deleteUserSessions(user.id);
      store.audit(user.id, '2fa-reset-cli');
      console.log(`Two-factor authentication removed for ${user.username}; they can set it up again after signing in`);
      break;
    }
    default:
      console.log('Commands: list-users | reset-password <username> | create-user <username> [name] [--admin] | set-admin <username> on|off | enable <username> | disable-2fa <username>');
      process.exitCode = command ? 1 : 0;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  store.close();
}
