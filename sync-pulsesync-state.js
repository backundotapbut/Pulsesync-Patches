#!/usr/bin/env node
/**
 * PulseSync State Sync
 *
 * Восстанавливает в клиенте PulseSync запись об установленном моде после
 * изменения app.asar (например, после unlock-premium.js).
 *
 * Клиент хранит SHA-256 установленного app.asar в зашифрованном
 * %APPDATA%\PulseSync\pulsesync_settings.json. Если хэш не совпадает,
 * клиент считает мод неустановленным, рвёт сокет мода и отключает аддоны.
 *
 * Скрипт пересчитывает хэш реального app.asar и записывает его в конфиг.
 *
 * Использование:
 *   node sync-pulsesync-state.js
 *   node sync-pulsesync-state.js --dry-run
 *   node sync-pulsesync-state.js --restore [path]
 *
 * Перед запуском закройте PulseSync (иначе он перезапишет конфиг при выходе).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const VERSION = '1.0.0';
const STORE_PASSWORD = 'pulsesync';
const BACKUP_FOLDER_NAME = 'premium-unlock-backup';
const STORE_SEPARATOR = 0x3a; // ':'

const log = {
    info: (...args) => console.log('[i]', ...args),
    ok: (...args) => console.log('[+]', ...args),
    warn: (...args) => console.log('[!]', ...args),
    err: (...args) => console.error('[-]', ...args),
};

function parseArgs(argv) {
    const args = { dryRun: false, restore: null, force: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') args.dryRun = true;
        else if (a === '--restore') {
            const next = argv[i + 1];
            if (next && !next.startsWith('--')) {
                args.restore = next;
                i++;
            } else {
                args.restore = '';
            }
        } else if (a === '--force') args.force = true;
        else if (a === '--help' || a === '-h') {
            console.log('Использование: node sync-pulsesync-state.js [--dry-run] [--restore [path]] [--force]');
            process.exit(0);
        } else {
            log.err(`Неизвестный аргумент: ${a}`);
            process.exit(1);
        }
    }
    return args;
}

function findYandexMusicDir() {
    const candidates = [
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'YandexMusic'),
        path.join(process.env.PROGRAMFILES || '', 'YandexMusic'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'YandexMusic'),
    ];
    for (const dir of candidates) {
        if (dir && fs.existsSync(path.join(dir, 'resources', 'app.asar'))) return dir;
    }
    return null;
}

function isPulseSyncRunning() {
    try {
        const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq PulseSync.exe', '/FO', 'CSV', '/NH'], {
            encoding: 'utf8',
            windowsHide: true,
        });
        return /PulseSync\.exe/i.test(out);
    } catch {
        return false;
    }
}

function readAsarHeader(asarPath) {
    const fd = fs.openSync(asarPath, 'r');
    try {
        const headerSizeBuf = Buffer.alloc(16);
        fs.readSync(fd, headerSizeBuf, 0, 16, 0);
        const headerSize = headerSizeBuf.readUInt32LE(12);
        const headerBuf = Buffer.alloc(headerSize);
        fs.readSync(fd, headerBuf, 0, headerSize, 16);
        return { header: JSON.parse(headerBuf.toString('utf8')), headerSize };
    } finally {
        fs.closeSync(fd);
    }
}

function readAsarFile(asarPath, entryPath) {
    const { header, headerSize } = readAsarHeader(asarPath);
    let cur = header;
    for (const part of entryPath.split('/')) {
        if (!cur.files || !cur.files[part]) return null;
        cur = cur.files[part];
    }
    const offset = 16 + headerSize + Number(cur.offset);
    const fd = fs.openSync(asarPath, 'r');
    try {
        const buf = Buffer.alloc(cur.size);
        fs.readSync(fd, buf, 0, cur.size, offset);
        return buf;
    } finally {
        fs.closeSync(fd);
    }
}

function parseModMeta(asarPath) {
    const buf = readAsarFile(asarPath, 'package.json');
    if (!buf) throw new Error('Не удалось прочитать package.json из app.asar');
    const text = buf.toString('utf8');

    const ymVersion = /"version"\s*:\s*"([^"]+)"/.exec(text)?.[1] || '';
    const modVersion = /"modification"\s*:\s*\{[\s\S]*?"version"\s*:\s*"([^"]+)"/.exec(text)?.[1] || '';
    const realYmVersion = /"modification"\s*:\s*\{[\s\S]*?"realYMVersion"\s*:\s*"([^"]+)"/.exec(text)?.[1] || ymVersion;

    return { ymVersion, modVersion, realYmVersion };
}

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(1024 * 1024);
    try {
        let pos = 0;
        for (;;) {
            const n = fs.readSync(fd, buf, 0, buf.length, pos);
            if (n <= 0) break;
            hash.update(buf.subarray(0, n));
            pos += n;
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function decryptStore(buf) {
    if (buf[16] !== STORE_SEPARATOR) throw new Error('Неизвестный формат конфига PulseSync (ожидался разделитель ":")');
    const salt = buf.subarray(0, 16);
    const data = buf.subarray(17);
    const key = crypto.pbkdf2Sync(STORE_PASSWORD, salt, 10000, 32, 'sha512');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, salt);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    return JSON.parse(plain);
}

function encryptStore(json) {
    const salt = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(STORE_PASSWORD, salt, 10000, 32, 'sha512');
    const cipher = crypto.createCipheriv('aes-256-cbc', key, salt);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(json), 'utf8'), cipher.final()]);
    return Buffer.concat([salt, Buffer.from([STORE_SEPARATOR]), encrypted]);
}

function backupStore(storePath) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(__dirname, BACKUP_FOLDER_NAME, stamp, 'pulsesync');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'pulsesync_settings.json');
    fs.copyFileSync(storePath, target);
    return target;
}

function writeStoreAtomic(storePath, buf) {
    const tmp = `${storePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, storePath);
}

function restoreStore(restoreArg) {
    const root = path.join(__dirname, BACKUP_FOLDER_NAME);
    if (!fs.existsSync(root)) {
        log.err('Папка резервных копий не найдена.');
        process.exit(1);
    }

    let source = restoreArg;
    if (!source) {
        const dirs = fs.readdirSync(root, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort();
        for (let i = dirs.length - 1; i >= 0; i--) {
            const candidate = path.join(root, dirs[i], 'pulsesync', 'pulsesync_settings.json');
            if (fs.existsSync(candidate)) {
                source = candidate;
                break;
            }
        }
    }

    if (!source || !fs.existsSync(source)) {
        log.err('Резервная копия конфига PulseSync не найдена.');
        process.exit(1);
    }

    const storePath = path.join(process.env.APPDATA || '', 'PulseSync', 'pulsesync_settings.json');
    if (isPulseSyncRunning()) {
        log.err('PulseSync запущен. Закройте его полностью и повторите.');
        process.exit(1);
    }
    if (fs.existsSync(storePath)) backupStore(storePath);
    fs.copyFileSync(source, storePath);
    log.ok(`Конфиг восстановлен из ${source}`);
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    log.info(`PulseSync State Sync v${VERSION}`);

    if (args.restore !== null) {
        restoreStore(args.restore);
        return;
    }

    const ymDir = findYandexMusicDir();
    if (!ymDir) {
        log.err('Не найдена установленная Яндекс Музыка.');
        process.exit(1);
    }

    const asarPath = path.join(ymDir, 'resources', 'app.asar');
    const unpackedMarker = path.join(ymDir, 'resources', 'app.asar.unpacked', '.pulsesync_unpacked_checksum');
    const storePath = path.join(process.env.APPDATA || '', 'PulseSync', 'pulsesync_settings.json');

    log.info(`Яндекс Музыка: ${ymDir}`);
    log.info(`app.asar: ${asarPath}`);
    log.info(`Конфиг PulseSync: ${storePath}`);

    if (!fs.existsSync(storePath)) {
        log.err('Конфиг PulseSync не найден. Запустите PulseSync хотя бы один раз.');
        process.exit(1);
    }

    if (isPulseSyncRunning() && !args.dryRun && !args.force) {
        log.err('PulseSync запущен. Полностью закройте его (включая иконку в трее) и повторите.');
        log.err('Или запустите с --force, чтобы завершить процессы PulseSync принудительно.');
        process.exit(1);
    }

    const meta = parseModMeta(asarPath);
    if (!meta.modVersion) {
        log.err('Не удалось определить версию мода в app.asar.');
        process.exit(1);
    }

    const asarChecksum = sha256File(asarPath);
    const unpackedChecksum = fs.existsSync(unpackedMarker)
        ? fs.readFileSync(unpackedMarker, 'utf8').trim()
        : '';

    const storeBuf = fs.readFileSync(storePath);
    const store = decryptStore(storeBuf);

    const nextMod = {
        musicVersion: meta.ymVersion,
        realMusicVersion: meta.realYmVersion,
        name: 'PulseSync',
        version: meta.modVersion,
        installed: true,
        updated: false,
        checksum: asarChecksum,
        unpackedChecksum,
        sourceType: 'stable',
        branch: '',
        commit: '',
    };

    log.info(`Версия мода: ${nextMod.version}`);
    log.info(`Версия Яндекс Музыки: ${nextMod.musicVersion} (real: ${nextMod.realMusicVersion})`);
    log.info(`SHA-256 app.asar: ${asarChecksum}`);
    log.info(`SHA-256 app.asar.unpacked: ${unpackedChecksum || '(нет маркера)'}`);
    log.info(`Текущее состояние в клиенте: installed=${store.mod?.installed === true}, version=${store.mod?.version || '(пусто)'}, checksum=${store.mod?.checksum || '(пусто)'}`);

    if (args.dryRun) {
        log.warn('Режим --dry-run: конфиг не изменён.');
        return;
    }

    if (isPulseSyncRunning() && args.force) {
        log.warn('Завершаю процессы PulseSync (--force)...');
        try {
            execFileSync('taskkill', ['/F', '/IM', 'PulseSync.exe'], { stdio: 'ignore', windowsHide: true });
        } catch {
            // процессы уже могли завершиться
        }
        // даём Windows освободить файлы
        const deadline = Date.now() + 10000;
        while (isPulseSyncRunning() && Date.now() < deadline) {
            try { execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 200'], { stdio: 'ignore', windowsHide: true }); } catch {}
        }
        if (isPulseSyncRunning()) {
            log.err('Не удалось завершить PulseSync. Закройте его вручную.');
            process.exit(1);
        }
    }

    const backupPath = backupStore(storePath);
    log.info(`Резервная копия: ${backupPath}`);

    store.mod = nextMod;
    writeStoreAtomic(storePath, encryptStore(store));

    // Проверяем, что запись читается и хэш совпадает.
    const verify = decryptStore(fs.readFileSync(storePath));
    if (verify.mod?.installed !== true || verify.mod?.checksum !== asarChecksum) {
        log.err('Проверка после записи не прошла.');
        process.exit(1);
    }

    log.ok('Состояние мода в клиенте PulseSync обновлено.');
    log.ok('Теперь запустите PulseSync, затем Яндекс Музыку.');
}

main();
