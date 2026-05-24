/**
 * `lwr auth whoami`
 *
 * Calls Redmine's users/current endpoint with the active profile's API key.
 * Doubles as a smoke test for both auth + network.
 */

import { runCommand, type CommandFn, type CommandResult, type GlobalFlags } from '../../foundation/run';
import { openSession } from '../../foundation/session';
import { getCurrentUser } from '../../api/users';
import { writeLine } from '../../foundation/output';
import { header, dim } from '../../foundation/format';

interface WhoamiPayload {
  profile: string;
  baseUrl: string;
  user: {
    id: number;
    login?: string;
    firstname?: string;
    lastname?: string;
    mail?: string;
  };
}

const cmd: CommandFn<WhoamiPayload> = async (flags): Promise<CommandResult<WhoamiPayload>> => {
  const session = await openSession(flags);
  const user = await getCurrentUser(session.client);
  return {
    json: {
      profile: session.profileName,
      baseUrl: session.baseUrl,
      user: {
        id: user.id,
        login: user.login,
        firstname: user.firstname,
        lastname: user.lastname,
        mail: user.mail,
      },
    },
    pretty: ctx => {
      const fullName = [user.firstname, user.lastname].filter(Boolean).join(' ');
      writeLine(header(ctx, fullName || user.login || `#${user.id}`));
      writeLine(`  ${dim(ctx, 'login  :')} ${user.login ?? '-'}`);
      writeLine(`  ${dim(ctx, 'mail   :')} ${user.mail ?? '-'}`);
      writeLine(`  ${dim(ctx, 'profile:')} ${session.profileName}`);
      writeLine(`  ${dim(ctx, 'baseUrl:')} ${session.baseUrl}`);
    },
  };
};

export function whoami(flags: GlobalFlags): Promise<never> {
  return runCommand('auth.whoami', flags, cmd);
}
