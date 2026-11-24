import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { loadConfig } from './config';
import { openDatabase } from './db/connection';
import { currentSchemaVersion, runMigrations } from './db/migrations';
import { countUsers, createUser, getUserByUsername, recordAudit, updatePassword } from './db/users';
import { deleteSessionsForUser } from './db/sessions';
import { ensureDiarySetup } from './db/diary';
import { hashPassword } from './auth/passwords';
import { isValidIanaZone, nowInstant } from '@shared/time';
import { normalizeUsername, passwordSchema, usernameSchema } from '@shared/schemas';
import { APP_VERSION } from './app';

const ENC_MAGIC = Buffer.from('SDBAK1');

function printHelp(): void {
  console.log(`Seizure Diary operator CLI

Usage: tsx server/src/cli.ts <command> [options]

Commands:
  migrate                         Apply pending SQLite migrations and exit.
  bootstrap-admin                 Create the first admin (hidden password prompt).
                                  Options: --username <name> --display-label <label>
                                  --password-stdin (non-interactive; read one password line)
  reset-password <username>       Operator recovery: set a new permanent password
                                  (hidden prompt, or --password-stdin). Revokes all sessions.
  backup                          Consistent SQLite snapshot. Encrypts with
                                  BACKUP_ENCRYPTION_KEY unless --no-encrypt.
                                  Options: --retain <n> (default 14), --no-encrypt
  verify-backup <file>            Decrypt (if .enc) and run SQLite integrity_check.
  restore-backup <file> [--force] Restore a snapshot to the configured DB path.
                                  Stop the service first. Removes stale WAL/SHM.
  status                          Print schema version and safe paths (no diary data).
  version                         Print application version.

Environment: SEIZURE_DIARY_DB_PATH, BACKUP_DIR, BACKUP_ENCRYPTION_KEY (base64, 32 bytes).
`);
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function readLine(): string {
  const bytes: number[] = [];
  const buffer = Buffer.alloc(1);
  for (;;) {
    let read = 0;
    try {
      read = fs.readSync(0, buffer, 0, 1, null);
    } catch (error) {
      if ((error as { code?: string }).code === 'EAGAIN') continue;
      throw error;
    }
    if (read === 0) break;
    const char = buffer.toString('utf8', 0, 1);
    if (char === '\n') break;
    if (char !== '\r') bytes.push(buffer[0] as number);
  }
  return Buffer.from(bytes).toString('utf8');
}

function promptVisible(question: string): string {
  process.stdout.write(question);
  return readLine();
}

function promptHidden(question: string): string {
  process.stdout.write(question);
  let echoDisabled = false;
  if (process.stdin.isTTY) {
    try {
      execFileSync('stty', ['-echo'], { stdio: ['inherit', 'inherit', 'inherit'] });
      echoDisabled = true;
    } catch {
      echoDisabled = false;
    }
  }
  const value = readLine();
  if (echoDisabled) {
    try {
      execFileSync('stty', ['echo'], { stdio: ['inherit', 'inherit', 'inherit'] });
    } catch {
      // best effort
    }
  }
  process.stdout.write('\n');
  return value;
}

function readNewPassword(args: string[]): string {
  if (args.includes('--password-stdin')) {
    const raw = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    const parsedStdin = passwordSchema.safeParse(raw);
    if (!parsedStdin.success) {
      console.error('Password must be 15–128 characters. Nothing was changed.');
      process.exit(1);
    }
    return raw;
  }
  const first = promptHidden('New password (hidden): ');
  const parsed = passwordSchema.safeParse(first);
  if (!parsed.success) {
    console.error('Password must be 15–128 characters. Nothing was changed.');
    process.exit(1);
  }
  const second = promptHidden('Confirm new password (hidden): ');
  if (first !== second) {
    console.error('Passwords did not match. Nothing was changed.');
    process.exit(1);
  }
  return first;
}

function encryptionKey(): Buffer | null {
  const raw = process.env.BACKUP_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('BACKUP_ENCRYPTION_KEY must be base64 for exactly 32 bytes.');
  }
  return key;
}

function encryptFile(source: string, destination: string, key: Buffer): void {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = fs.readFileSync(source);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  fs.writeFileSync(destination, Buffer.concat([ENC_MAGIC, iv, tag, ciphertext]), { mode: 0o600 });
}

function decryptFile(source: string, destination: string, key: Buffer): void {
  const content = fs.readFileSync(source);
  if (content.subarray(0, ENC_MAGIC.length).compare(ENC_MAGIC) !== 0) {
    throw new Error('Not an encrypted Seizure Diary backup.');
  }
  const iv = content.subarray(ENC_MAGIC.length, ENC_MAGIC.length + 12);
  const tag = content.subarray(ENC_MAGIC.length + 12, ENC_MAGIC.length + 28);
  const ciphertext = content.subarray(ENC_MAGIC.length + 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  fs.writeFileSync(destination, plaintext, { mode: 0o600 });
}

function verifySnapshot(file: string): number {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const result = db.pragma('integrity_check') as { integrity_check: string }[];
    const first = result[0]?.integrity_check;
    if (first !== 'ok') throw new Error(`Integrity check failed: ${first}`);
    return currentSchemaVersion(db);
  } finally {
    db.close();
  }
}

function commandMigrate(): void {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  try {
    const version = runMigrations(db);
    console.log(`Migrations applied. Schema version: ${version}. Database: ${config.dbPath}`);
  } finally {
    db.close();
  }
}

async function commandBootstrapAdmin(args: string[]): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  try {
    runMigrations(db);
    if (countUsers(db) > 0) {
      console.error('This database is already provisioned. Refusing to create a first admin.');
      process.exit(1);
    }
    const usernameRaw = flagValue(args, '--username') ?? promptVisible('Admin username: ');
    const username = normalizeUsername(usernameRaw);
    if (!usernameSchema.safeParse(username).success) {
      console.error('Username must be 3–32 characters: lowercase letters, digits, dot, underscore or hyphen.');
      process.exit(1);
    }
    const displayLabel =
      flagValue(args, '--display-label') ??
      (process.stdin.isTTY ? promptVisible('Display label (optional): ') : '');
    const password = readNewPassword(args);
    const passwordHash = await hashPassword(password);
    const now = nowInstant();
    const zone = process.env.DEFAULT_REPORT_ZONE ?? 'UTC';
    if (!isValidIanaZone(zone)) {
      console.error(`Invalid DEFAULT_REPORT_ZONE: ${zone}`);
      process.exit(1);
    }
    const user = db.transaction(() => {
      const created = createUser(db, {
        username,
        displayLabel: displayLabel.trim() || null,
        role: 'admin',
        passwordHash,
        mustChangePassword: false,
        tempPasswordExpiresAt: null,
        now,
      });
      ensureDiarySetup(db, created.id, zone, now);
      recordAudit(
        db,
        { actorId: null, targetId: created.id, action: 'admin_bootstrap', outcome: 'success' },
        now,
      );
      return created;
    })();
    console.log(`First admin "${user.username}" created. Sign in and keep the password private.`);
  } finally {
    db.close();
  }
}

async function commandResetPassword(args: string[]): Promise<void> {
  const config = loadConfig();
  const username = normalizeUsername(args[0] ?? promptVisible('Username to reset: '));
  const db = openDatabase(config.dbPath);
  try {
    runMigrations(db);
    const user = getUserByUsername(db, username);
    if (!user) {
      console.error('No such account.');
      process.exit(1);
    }
    const password = readNewPassword(args);
    const passwordHash = await hashPassword(password);
    const now = nowInstant();
    db.transaction(() => {
      updatePassword(db, user.id, passwordHash, {
        mustChangePassword: false,
        tempPasswordExpiresAt: null,
        now,
      });
      deleteSessionsForUser(db, user.id);
      recordAudit(
        db,
        { actorId: null, targetId: user.id, action: 'operator_password_reset', outcome: 'success' },
        now,
      );
    })();
    console.log(`Password reset for "${user.username}". All sessions were revoked.`);
  } finally {
    db.close();
  }
}

function commandBackup(args: string[]): void {
  const config = loadConfig();
  fs.mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
  const key = encryptionKey();
  const noEncrypt = args.includes('--no-encrypt');
  if (!key && !noEncrypt) {
    console.error(
      'Set BACKUP_ENCRYPTION_KEY (base64, 32 bytes) to encrypt the snapshot, or pass --no-encrypt for a local test only.',
    );
    process.exit(1);
  }
  const db = openDatabase(config.dbPath, { readonly: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(config.backupDir, `seizure-diary_${stamp}.sqlite3`);
  try {
    const quoted = base.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${quoted}'`);
  } finally {
    db.close();
  }
  const schemaVersion = verifySnapshot(base);
  let finalPath = base;
  if (key) {
    finalPath = `${base}.enc`;
    encryptFile(base, finalPath, key);
    fs.rmSync(base);
  }
  fs.chmodSync(finalPath, 0o600);

  const retainRaw = flagValue(args, '--retain') ?? '14';
  const retain = Number.parseInt(retainRaw, 10);
  if (Number.isFinite(retain) && retain > 0) {
    const files = fs
      .readdirSync(config.backupDir)
      .filter((name) => name.startsWith('seizure-diary_') && /\.(sqlite3|enc)$/.test(name))
      .map((name) => {
        const full = path.join(config.backupDir, name);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const stale of files.slice(retain)) {
      fs.rmSync(stale.full, { force: true });
    }
  }
  console.log(
    `Backup written: ${finalPath} (schema ${schemaVersion}${key ? ', encrypted' : ', UNENCRYPTED'}).`,
  );
  if (!key) console.warn('Warning: unencrypted backups must not leave guest-local trusted storage.');
}

function commandVerifyBackup(args: string[]): void {
  const file = args[0];
  if (!file) {
    console.error('Usage: verify-backup <file>');
    process.exit(1);
  }
  const key = encryptionKey();
  let target = file;
  let temporary: string | null = null;
  try {
    if (file.endsWith('.enc')) {
      if (!key) {
        console.error('BACKUP_ENCRYPTION_KEY is required to verify an encrypted backup.');
        process.exit(1);
      }
      temporary = `${file}.verify-tmp`;
      decryptFile(file, temporary, key);
      target = temporary;
    }
    const schemaVersion = verifySnapshot(target);
    console.log(`Backup OK: ${file} (schema ${schemaVersion}).`);
  } finally {
    if (temporary) fs.rmSync(temporary, { force: true });
  }
}

function commandRestoreBackup(args: string[]): void {
  const file = args[0];
  if (!file) {
    console.error('Usage: restore-backup <file> [--force]');
    process.exit(1);
  }
  const config = loadConfig();
  const force = args.includes('--force');
  const key = encryptionKey();
  let source = file;
  let temporary: string | null = null;
  try {
    if (file.endsWith('.enc')) {
      if (!key) {
        console.error('BACKUP_ENCRYPTION_KEY is required to restore an encrypted backup.');
        process.exit(1);
      }
      temporary = `${file}.restore-tmp`;
      decryptFile(file, temporary, key);
      source = temporary;
    }
    const schemaVersion = verifySnapshot(source);
    if (fs.existsSync(config.dbPath) && !force) {
      console.error(
        `Refusing to overwrite existing database ${config.dbPath}. Stop the service and pass --force after taking a fresh backup.`,
      );
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, config.dbPath);
    for (const sidecar of [`${config.dbPath}-wal`, `${config.dbPath}-shm`]) {
      fs.rmSync(sidecar, { force: true });
    }
    const db = openDatabase(config.dbPath);
    try {
      deleteSessionsForUserAll(db);
    } finally {
      db.close();
    }
    console.log(`Restored ${file} to ${config.dbPath} (schema ${schemaVersion}). All sessions revoked.`);
  } finally {
    if (temporary) fs.rmSync(temporary, { force: true });
  }
}

function deleteSessionsForUserAll(db: import('better-sqlite3').Database): void {
  db.prepare('DELETE FROM sessions').run();
}

function commandStatus(): void {
  const config = loadConfig();
  const exists = fs.existsSync(config.dbPath);
  let schemaVersion: number | null = null;
  let users: number | null = null;
  if (exists) {
    const db = openDatabase(config.dbPath, { readonly: true });
    try {
      schemaVersion = currentSchemaVersion(db);
      users = countUsers(db);
    } finally {
      db.close();
    }
  }
  console.log(
    JSON.stringify(
      {
        version: APP_VERSION,
        dbPath: config.dbPath,
        dbExists: exists,
        schemaVersion,
        users,
        backupDir: config.backupDir,
        publicOrigin: config.publicOrigin,
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'migrate':
      commandMigrate();
      break;
    case 'bootstrap-admin':
      await commandBootstrapAdmin(args);
      break;
    case 'reset-password':
      await commandResetPassword(args);
      break;
    case 'backup':
      commandBackup(args);
      break;
    case 'verify-backup':
      commandVerifyBackup(args);
      break;
    case 'restore-backup':
      commandRestoreBackup(args);
      break;
    case 'status':
      commandStatus();
      break;
    case 'version':
      console.log(APP_VERSION);
      break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error('Command failed:', (error as Error).message);
  process.exit(1);
});
