/**
 * Sets a user's password (e.g. to recover a locked-out administrator).
 *   NEW_PASSWORD='...' node server/dist/scripts/set-password.js <email>
 * The password is read from the environment so it never appears as a command-line argument.
 */
import bcrypt from 'bcryptjs';
import { closeDb, db } from '../src/db.js';

const [email] = process.argv.slice(2);
const password = process.env.NEW_PASSWORD;
if (!email || !password || password.length < 10) {
  console.error('Usage: NEW_PASSWORD=<10+ characters> set-password <email>');
  process.exit(1);
}
try {
  const n = await db()('users')
    .whereRaw('lower(email) = lower(?)', [email])
    .update({ password_hash: await bcrypt.hash(password, 12), updated_at: db().fn.now() });
  if (n === 0) {
    console.error(`No account with email ${email}`);
    process.exitCode = 1;
  } else {
    // End existing sessions for that account.
    await db().raw(`delete from session where (sess->>'userId')::bigint = (select id from users where lower(email) = lower(?))`, [email]);
    console.log(`Password updated for ${email}.`);
  }
} finally {
  await closeDb();
}
