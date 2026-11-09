/**
 * Creates an administrator account (e.g. the first admin after deployment).
 *   ADMIN_PASSWORD='...' node server/dist/scripts/create-admin.js admin@example.edu "Display Name"
 * The password is read from the environment so it never appears in shell history arguments.
 */
import bcrypt from 'bcryptjs';
import { closeDb, db } from '../src/db.js';

const [email, displayName] = process.argv.slice(2);
const password = process.env.ADMIN_PASSWORD;
if (!email || !displayName || !password) {
  console.error('Usage: ADMIN_PASSWORD=... create-admin <email> "<display name>"');
  process.exit(1);
}
if (password.length < 10) {
  console.error('Password must be at least 10 characters');
  process.exit(1);
}
try {
  const exists = await db()('users').whereRaw('lower(email) = lower(?)', [email]).first();
  if (exists) {
    console.error('An account with that email already exists; use the Administration page to change its role.');
    process.exitCode = 1;
  } else {
    await db()('users').insert({
      email,
      display_name: displayName,
      role: 'admin',
      is_faculty: false,
      password_hash: await bcrypt.hash(password, 12),
    });
    console.log(`Administrator ${email} created.`);
  }
} finally {
  await closeDb();
}
