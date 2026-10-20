// Pilot accounts from the shell: node users-cli.js <usersFile> add <name> [--admin] | list | remove <name> | passwd <name>
// Passwords are read from stdin: without echo on a terminal, one line each otherwise.
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { UserStore } from './users.js';

const USAGE = 'usage: users-cli.js <usersFile> add <name> [--admin] | list | remove <name> | passwd <name>';

/** Returns ask(prompt) -> Promise<string>. */
function passwordReader(input, output) {
  if (input.isTTY) {
    return (prompt) => new Promise((resolve) => {
      output.write(prompt);
      let text = '';
      input.setRawMode(true);
      input.resume();
      input.setEncoding('utf8');
      const onData = (chunk) => {
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n' || ch === '\u0004') {
            input.setRawMode(false);
            input.pause();
            input.off('data', onData);
            output.write('\n');
            resolve(text);
            return;
          }
          if (ch === '\u0003') { output.write('\n'); process.exit(130); }
          if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
          else text += ch;
        }
      };
      input.on('data', onData);
    });
  }
  const lines = createInterface({ input })[Symbol.asyncIterator]();
  return async () => (await lines.next()).value ?? '';
}

async function newPassword(ask) {
  const first = await ask('Password: ');
  if (first !== await ask('Repeat password: ')) throw new Error('the passwords do not match');
  return first;
}

export async function run(argv, { input = process.stdin, output = process.stdout } = {}) {
  const [file, cmd, name, ...flags] = argv;
  if (!file || !['add', 'list', 'remove', 'passwd'].includes(cmd) || (cmd !== 'list' && !name)) throw new Error(USAGE);
  const store = new UserStore(file);
  await store.load();
  if (cmd === 'list') {
    for (const u of store.list()) output.write(`${u.name}${u.admin ? ' (admin)' : ''}\n`);
  } else if (cmd === 'remove') {
    await store.remove(name);
  } else {
    const ask = passwordReader(input, output);
    const password = await newPassword(ask);
    if (cmd === 'add') await store.add(name, password, flags.includes('--admin'));
    else await store.setPassword(name, password);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(() => process.exit(0), (err) => {
    console.error(err.message);
    process.exit(1);
  });
}
