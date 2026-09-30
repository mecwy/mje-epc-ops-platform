// TEST only. Loaded with `node --import` by scripts/add-member-integration.mjs so that the
// unchanged cloud-add-member.mjs entry point (guards, sanitising handler, transaction) runs
// against a local, isolated TEST database. Only the two imports that reach Azure are replaced,
// and only when cloud-add-member.mjs itself imports them:
// - @azure/identity: a credential that returns the TEST token from the environment (or fails);
// - pg: a Client that checks the connection settings the script chose (database, port, TLS,
//   pinned search_path, the token as password) and then connects to the local TEST database
//   instead of the Azure server, keeping the pinned search_path.
// Without a local TEST database URL this module refuses to load, so it cannot redirect a run
// anywhere else.
import { registerHooks } from 'node:module';
import { assertLocalDatabase } from './local-db.mjs';

const target = process.env.ADD_MEMBER_TEST_DATABASE_URL;
if (!target)
  throw new Error('add-member test hooks need ADD_MEMBER_TEST_DATABASE_URL');
// The URL alone decides the destination (the child's PGHOST is the Dev pattern on purpose).
assertLocalDatabase(target, {});

const IDENTITY = `
export class ManagedIdentityCredential {
  constructor(options) {
    if (options?.clientId !== 'TEST') throw new Error('add-member test: unexpected client id');
  }
  async getToken(scope) {
    if (scope !== 'https://ossrdbms-aad.database.windows.net/.default')
      throw new Error('add-member test: unexpected scope');
    const mode = process.env.ADD_MEMBER_TEST_CREDENTIAL ?? 'token';
    if (mode === 'fail') {
      // Shaped like an SDK failure whose message carries an identifier and an endpoint.
      const error = new Error('ManagedIdentityCredential: no identity for ' +
        process.env.MEMBER_OBJECT_ID + ' at http://169.254.169.254/metadata/identity');
      error.name = 'CredentialUnavailableError';
      throw error;
    }
    if (mode === 'empty') return null;
    return { token: process.env.ADD_MEMBER_TEST_TOKEN, expiresOnTimestamp: Date.now() + 600000 };
  }
}
`;
const pgSource = (realPath) => `
import { createRequire } from 'node:module';
const real = createRequire(${JSON.stringify(realPath)})(${JSON.stringify(realPath)});
class Client extends real.Client {
  constructor(config) {
    if (config.database !== 'mje' || config.port !== 5432 ||
        config.ssl?.rejectUnauthorized !== true ||
        config.options !== '-c search_path=pg_catalog' ||
        config.password !== process.env.ADD_MEMBER_TEST_TOKEN)
      throw new Error('add-member test: unexpected connection settings');
    super({
      connectionString: process.env.ADD_MEMBER_TEST_DATABASE_URL,
      options: config.options,
      application_name: 'mje-add-member-test',
    });
  }
}
export default { Client };
`;
const dataUrl = (source) =>
  `data:text/javascript,${encodeURIComponent(source)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/scripts/cloud-add-member.mjs')) {
      if (/[\\/]@azure[\\/]identity[\\/]/.test(specifier))
        return { url: dataUrl(IDENTITY), shortCircuit: true };
      if (/[\\/]pg[\\/]lib[\\/]index\.js$/.test(specifier))
        return { url: dataUrl(pgSource(specifier)), shortCircuit: true };
      // Anything else the script imports must be a builtin or the local mapping helper, so a
      // changed import can never reach the real SDK unnoticed.
      if (!/^node:/.test(specifier) && specifier !== './entra-mapping.mjs')
        throw new Error('add-member test: unexpected import from the script');
    }
    return nextResolve(specifier, context);
  },
});
