#!/usr/bin/env node
/**
 * PulseSync Premium Unlock
 *
 * Патчит установленный мод PulseSync (app.asar + integrity-хэш в exe)
 * и, при наличии, исходники проекта, чтобы все проверки isPremiumUser
 * возвращали true.
 *
 * Использование:
 *   node unlock-premium.js
 *   node unlock-premium.js --dry-run
 *   node unlock-premium.js --installed-only
 *   node unlock-premium.js --source-only
 *   node unlock-premium.js --restore
 *
 * Перед патчем установленного мода закройте Яндекс Музыку.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const VERSION = '1.1.0';
const SCRIPT_DIR = __dirname;
const ASAR_UNPACK_DIR = 'node_modules/{@img,sharp}';
const BACKUP_FOLDER_NAME = 'premium-unlock-backup';

const log = {
    info: (...args) => console.log('[i]', ...args),
    ok: (...args) => console.log('[+]', ...args),
    warn: (...args) => console.log('[!]', ...args),
    err: (...args) => console.error('[-]', ...args),
};

// ---------------------------------------------------------------------------
// Патчи установленного app.asar (минифицированные файлы версии 2.1.4)
// ---------------------------------------------------------------------------

const INSTALLED_PATCHES = [
    {
        file: 'main/lib/pulsesync/PulseSyncManager.js',
        required: true,
        replacements: [
            {
                from: 'const i=Boolean(e),s=this.isPremium!==i;',
                to: 'const i=!0,s=this.isPremium!==i;',
            },
            {
                from: 'get isPremiumUser(){return this.isPremium}',
                to: 'get isPremiumUser(){return!0}',
            },
        ],
    },
    {
        file: 'app/pulsesync-runtime/runtime.js',
        required: true,
        replacements: [
            {
                from: 'getPremiumStatus:async()=>!!await Ms().app.isPremiumUser()',
                to: 'getPremiumStatus:async()=>!0',
            },
        ],
    },
    {
        file: 'main/events.js',
        required: false,
        replacements: [
            {
                from: 'const e=Boolean(getPulseSyncManager()?.isPremiumUser);t&&!e&&',
                to: 'const e=!0;t&&!e&&',
            },
            {
                from: 'getPulseSyncManager().isPremiumUser',
                to: '!0',
            },
            {
                from: 'e.returnValue=Boolean(getPulseSyncManager()?.isPremiumUser)',
                to: 'e.returnValue=!0',
            },
        ],
    },
    {
        file: 'main/lib/preload.js',
        required: false,
        replacements: [
            {
                from: 'return Boolean(electron_1.ipcRenderer.sendSync("isPremiumUserSync"))',
                to: 'return!0',
            },
        ],
    },
    {
        file: 'main/lib/discordRichPresence.js',
        required: false,
        replacements: [
            {
                from: 'const v=Boolean(pulseSyncManager_js_1.getPulseSyncManager()?.isPremiumUser)',
                to: 'const v=!0',
            },
        ],
    },
    {
        file: 'main/lib/pulsesync/desktopBridge.js',
        required: false,
        replacements: [
            {
                from: 'isPremiumUser:()=>ipcRenderer.invoke("isPremiumUser")',
                to: 'isPremiumUser:()=>Promise.resolve(!0)',
            },
        ],
    },
    {
        file: 'app/pulsesync-web/host.js',
        required: false,
        replacements: [
            {
                from: 'e.getPremiumStatus().then(e=>{t&&l(e)})',
                to: 'Promise.resolve(!0).then(e=>{t&&l(e)})',
            },
        ],
    },
];

// ---------------------------------------------------------------------------
// Патчи исходников (неминифицированные файлы)
// ---------------------------------------------------------------------------

const SOURCE_PATCHES = [
    {
        file: 'src/main/lib/pulsesync/PulseSyncManager.js',
        required: true,
        replacements: [
            {
                from: 'const nextValue = Boolean(isPremium);',
                to: 'const nextValue = true;',
            },
            {
                from: '    get isPremiumUser() {\n        return this.isPremium;\n    }',
                to: '    get isPremiumUser() {\n        return true;\n    }',
            },
        ],
    },
    {
        file: 'webModules/pulsesyncRuntime/src/api/pulsesyncApi.ts',
        required: true,
        replacements: [
            {
                from: 'return Boolean(await getDesktopBridge().app.isPremiumUser());',
                to: 'return true;',
            },
        ],
    },
    {
        file: 'src/main/events.js',
        required: false,
        replacements: [
            {
                from: 'const isPremium = Boolean(getPulseSyncManager()?.isPremiumUser);',
                to: 'const isPremium = true;',
            },
            {
                from: 'return getPulseSyncManager().isPremiumUser;',
                to: 'return true;',
            },
            {
                from: 'event.returnValue = Boolean(getPulseSyncManager()?.isPremiumUser);',
                to: 'event.returnValue = true;',
            },
        ],
    },
    {
        file: 'src/main/lib/preload.js',
        required: false,
        replacements: [
            {
                from: "return Boolean(electron_1.ipcRenderer.sendSync('isPremiumUserSync'));",
                to: 'return true;',
            },
        ],
    },
    {
        file: 'src/main/lib/discordRichPresence.js',
        required: false,
        replacements: [
            {
                from: 'const isPremiumUser = Boolean(pulseSyncManager_js_1.getPulseSyncManager()?.isPremiumUser);',
                to: 'const isPremiumUser = true;',
            },
        ],
    },
];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const args = { _: [] };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (arg === '--help' || arg === '-h') {
            args.help = true;
        } else if (arg === '--version' || arg === '-v') {
            args.version = true;
        } else if (arg === '--dry-run') {
            args.dryRun = true;
        } else if (arg === '--installed-only') {
            args.installedOnly = true;
        } else if (arg === '--source-only') {
            args.sourceOnly = true;
        } else if (arg === '--keep-temp') {
            args.keepTemp = true;
        } else if (arg === '--yes' || arg === '-y') {
            args.yes = true;
        } else if (arg === '--restore') {
            args.restore = true;
            if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
                args.restoreDir = argv[++i];
            }
        } else if (arg === '--install-dir') {
            args.installDir = requireValue(argv, ++i, arg);
        } else if (arg === '--source-dir') {
            args.sourceDir = requireValue(argv, ++i, arg);
        } else if (arg === '--backup-dir') {
            args.backupDir = requireValue(argv, ++i, arg);
        } else if (arg === '--asar-module') {
            args.asarModule = requireValue(argv, ++i, arg);
        } else if (arg.startsWith('-')) {
            throw new Error(`Неизвестная опция: ${arg}`);
        } else {
            args._.push(arg);
        }
    }

    return args;
}

function requireValue(argv, index, option) {
    const value = argv[index];
    if (!value || value.startsWith('-')) {
        throw new Error(`Для ${option} нужно указать значение.`);
    }
    return value;
}

function printHelp() {
    console.log(`PulseSync Premium Unlock v${VERSION}

Патчит установленный мод PulseSync и исходники так, чтобы isPremiumUser
всегда возвращал true. Перед патчем установленного мода закройте Яндекс Музыку.

Использование:
  node unlock-premium.js [опции]

Опции:
  --install-dir <path>   Папка установки Яндекс Музыки (где resources\\app.asar)
  --source-dir <path>    Папка исходников PulseSync
  --backup-dir <path>    Куда сохранять резервные копии
  --installed-only       Патчить только установленный мод
  --source-only          Патчить только исходники
  --dry-run              Показать, что будет изменено, ничего не записывая
  --restore [path]       Восстановить из резервной копии (последней или указанной)
  --keep-temp            Не удалять временную папку
  --asar-module <path>   Путь к @electron/asar (lib/asar.js или папке пакета)
  --help                 Эта справка

Примеры:
  node unlock-premium.js
  node unlock-premium.js --dry-run
  node unlock-premium.js --installed-only
  node unlock-premium.js --restore

После патча запустите Яндекс Музыку заново и проверьте настройки
"Интерфейс" и "Discord RPC".
`);
}

// ---------------------------------------------------------------------------
// Поиск установки и исходников
// ---------------------------------------------------------------------------

function findSourceDir() {
    const candidates = [SCRIPT_DIR, process.cwd()];

    for (const dir of candidates) {
        if (fs.existsSync(path.join(dir, 'src', 'main', 'lib', 'pulsesync', 'PulseSyncManager.js'))) {
            return dir;
        }
    }

    return null;
}

function findInstall(explicitDir) {
    const candidates = [];

    if (explicitDir) {
        candidates.push(path.resolve(explicitDir));
    }

    if (process.env.LOCALAPPDATA) {
        candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'YandexMusic'));
    }

    if (process.env.ProgramFiles) {
        candidates.push(path.join(process.env.ProgramFiles, 'YandexMusic'));
    }

    if (process.env['ProgramFiles(x86)']) {
        candidates.push(path.join(process.env['ProgramFiles(x86)'], 'YandexMusic'));
    }

    if (process.env.USERPROFILE) {
        candidates.push(path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Programs', 'YandexMusic'));
    }

    const seen = new Set();

    for (const dir of candidates) {
        const resolved = path.resolve(dir);
        if (seen.has(resolved)) continue;
        seen.add(resolved);

        const asarPath = path.join(resolved, 'resources', 'app.asar');
        if (fs.existsSync(asarPath)) {
            return {
                dir: resolved,
                asar: asarPath,
                unpacked: asarPath + '.unpacked',
                exe: findExe(resolved),
            };
        }
    }

    throw new Error(
        'Не найден resources\\app.asar. Укажите --install-dir "C:\\Users\\...\\AppData\\Local\\Programs\\YandexMusic".',
    );
}

function findExe(installDir) {
    const files = fs
        .readdirSync(installDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.exe$/i.test(entry.name) && !/^uninstall/i.test(entry.name))
        .map((entry) => {
            const fullPath = path.join(installDir, entry.name);
            let size = 0;
            try {
                size = fs.statSync(fullPath).size;
            } catch {
                // ignore
            }
            return { fullPath, name: entry.name, size };
        })
        .sort((a, b) => b.size - a.size);

    if (files.length === 0) {
        throw new Error(`В папке ${installDir} не найден .exe Яндекс Музыки.`);
    }

    const preferred = files.find((file) => /яндекс|yandex|music|музык/i.test(file.name));
    return (preferred || files[0]).fullPath;
}

function assertExeWritable(exePath) {
    try {
        const fd = fs.openSync(exePath, 'r+');
        fs.closeSync(fd);
    } catch (error) {
        if (['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) {
            throw new Error(
                `Файл ${exePath} заблокирован. Закройте Яндекс Музыку (все процессы) и повторите запуск.`,
            );
        }
        throw error;
    }
}

// ---------------------------------------------------------------------------
// @electron/asar
// ---------------------------------------------------------------------------

async function loadAsarModule(explicitPath) {
    const candidates = [];

    const add = (candidate) => {
        if (candidate) candidates.push(candidate);
    };

    if (explicitPath) {
        const resolved = path.resolve(explicitPath);
        add(resolved);
        add(path.join(resolved, 'lib', 'asar.js'));
        add(path.join(resolved, 'node_modules', '@electron', 'asar', 'lib', 'asar.js'));
    }

    for (const base of [SCRIPT_DIR, process.cwd()]) {
        try {
            const resolved = require.resolve('@electron/asar', { paths: [base] });
            add(resolved);
            try {
                if (fs.statSync(resolved).isDirectory()) {
                    add(path.join(resolved, 'lib', 'asar.js'));
                }
            } catch {
                // ignore
            }
        } catch {
            // ignore
        }
    }

    const npxRoot = path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx');
    if (fs.existsSync(npxRoot)) {
        for (const dir of fs.readdirSync(npxRoot)) {
            add(path.join(npxRoot, dir, 'node_modules', '@electron', 'asar', 'lib', 'asar.js'));
        }
    }

    if (process.env.APPDATA) {
        add(path.join(process.env.APPDATA, 'npm', 'node_modules', '@electron', 'asar', 'lib', 'asar.js'));
    }

    const seen = new Set();

    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        if (seen.has(resolved)) continue;
        seen.add(resolved);

        if (!fs.existsSync(resolved)) continue;

        try {
            const imported = await import(pathToFileURL(resolved).href);
            const mod =
                imported.default && typeof imported.default.extractAll === 'function'
                    ? imported.default
                    : imported;

            if (
                typeof mod.extractAll === 'function' &&
                typeof mod.createPackageWithOptions === 'function' &&
                typeof mod.getRawHeader === 'function'
            ) {
                log.info(`@electron/asar: ${resolved}`);
                return { mod, modulePath: resolved };
            }
        } catch {
            // Пробуем следующий кандидат.
        }
    }

    return null;
}

function quoteCmdArg(value) {
    const text = String(value);
    if (!/[\s"&|<>^]/.test(text)) return text;
    return '"' + text.replace(/"/g, '""') + '"';
}

function runAsarCli(args) {
    const npxArgs = ['--yes', '@electron/asar@4.3.1', ...args];

    if (process.platform === 'win32') {
        const commandLine = ['npx', ...npxArgs].map(quoteCmdArg).join(' ');
        const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
            stdio: 'inherit',
            windowsVerbatimArguments: true,
        });

        if (result.error) throw result.error;
        if (result.status !== 0) {
            throw new Error(`npx @electron/asar завершился с кодом ${result.status}.`);
        }
        return;
    }

    const result = spawnSync('npx', npxArgs, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`npx @electron/asar завершился с кодом ${result.status}.`);
    }
}

async function extractAsar(ctx, archivePath, destination) {
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(destination, { recursive: true });

    if (ctx.asar) {
        ctx.asar.mod.extractAll(archivePath, destination);
        return;
    }

    runAsarCli(['extract', archivePath, destination]);
}

async function packAsar(ctx, sourceDir, destination) {
    fs.rmSync(destination, { force: true });
    fs.rmSync(destination + '.unpacked', { recursive: true, force: true });

    if (ctx.asar) {
        await ctx.asar.mod.createPackageWithOptions(sourceDir, destination, {
            unpackDir: ASAR_UNPACK_DIR,
        });
        return;
    }

    runAsarCli(['pack', sourceDir, destination, '--unpack-dir', ASAR_UNPACK_DIR]);
}

// ---------------------------------------------------------------------------
// ASAR: чтение заголовка и файлов
// ---------------------------------------------------------------------------

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(filePath) {
    return sha256(fs.readFileSync(filePath));
}

function readAsarHeader(archivePath) {
    const fd = fs.openSync(archivePath, 'r');

    try {
        const sizeBuffer = Buffer.alloc(8);
        if (fs.readSync(fd, sizeBuffer, 0, 8, 0) !== 8) {
            throw new Error('Не удалось прочитать размер заголовка asar.');
        }

        const headerSize = sizeBuffer.readUInt32LE(4);
        const headerBuffer = Buffer.alloc(headerSize);

        if (fs.readSync(fd, headerBuffer, 0, headerSize, 8) !== headerSize) {
            throw new Error('Не удалось прочитать заголовок asar.');
        }

        const jsonLength = headerBuffer.readUInt32LE(4);
        const headerString = headerBuffer.subarray(8, 8 + jsonLength);
        const json = JSON.parse(headerString.toString('utf8'));

        return {
            headerSize,
            jsonLength,
            headerString,
            json,
            fileSize: fs.fstatSync(fd).size,
        };
    } finally {
        fs.closeSync(fd);
    }
}

function hashAsarHeader(archivePath) {
    return sha256(readAsarHeader(archivePath).headerString);
}

function walkHeader(node, prefix, callback) {
    if (node.files) {
        for (const [name, child] of Object.entries(node.files)) {
            walkHeader(child, prefix ? `${prefix}/${name}` : name, callback);
        }
        return;
    }

    callback(prefix, node);
}

function analyzeHeader(header) {
    let files = 0;
    let dirs = 0;
    let links = 0;
    let unpacked = 0;
    let withIntegrity = 0;
    const unpackedPaths = [];

    const walkDirs = (node, prefix) => {
        if (!node.files) return;

        dirs++;

        for (const [name, child] of Object.entries(node.files)) {
            const childPath = prefix ? `${prefix}/${name}` : name;

            if (child.files) {
                walkDirs(child, childPath);
                continue;
            }

            if (child.link !== undefined) {
                links++;
                continue;
            }

            files++;

            if (child.unpacked) {
                unpacked++;
                unpackedPaths.push(childPath);
            }

            if (child.integrity) {
                withIntegrity++;
            }
        }
    };

    walkDirs(header.json, '');

    return { files, dirs, links, unpacked, withIntegrity, unpackedPaths };
}

function getHeaderNode(header, filename) {
    let node = header.json;

    for (const part of filename.split('/')) {
        if (!node.files || !node.files[part]) {
            throw new Error(`В asar нет файла: ${filename}`);
        }
        node = node.files[part];
    }

    return node;
}

function readAsarFile(archivePath, header, filename) {
    const node = getHeaderNode(header, filename);

    if (node.link !== undefined) {
        throw new Error(`Символические ссылки не поддерживаются: ${filename}`);
    }

    if (node.unpacked) {
        return fs.readFileSync(path.join(archivePath + '.unpacked', ...filename.split('/')));
    }

    const offset = Number(node.offset);
    const size = Number(node.size);
    const fd = fs.openSync(archivePath, 'r');

    try {
        const buffer = Buffer.alloc(size);
        const position = 8 + header.headerSize + offset;
        const read = fs.readSync(fd, buffer, 0, size, position);

        if (read !== size) {
            throw new Error(`Не удалось прочитать файл из asar: ${filename}`);
        }

        return buffer;
    } finally {
        fs.closeSync(fd);
    }
}

function verifyIntegrityBuffer(buffer, integrity, label) {
    const hash = sha256(buffer);

    if (hash !== integrity.hash) {
        throw new Error(`SHA256 не совпадает: ${label}`);
    }

    const blockSize = Number(integrity.blockSize) || 4 * 1024 * 1024;
    const blocks = [];

    for (let offset = 0; offset < buffer.length; offset += blockSize) {
        blocks.push(sha256(buffer.subarray(offset, Math.min(offset + blockSize, buffer.length))));
    }

    if (buffer.length === 0) {
        blocks.push(sha256(buffer));
    }

    if (blocks.length !== integrity.blocks.length) {
        throw new Error(`Количество блоков не совпадает: ${label}`);
    }

    for (let index = 0; index < blocks.length; index++) {
        if (blocks[index] !== integrity.blocks[index]) {
            throw new Error(`Блок ${index} не совпадает: ${label}`);
        }
    }
}

function verifyArchiveIntegrity(archivePath, header, unpackedDir) {
    const fd = fs.openSync(archivePath, 'r');
    let data;

    try {
        const fileSize = fs.fstatSync(fd).size;
        const dataStart = 8 + header.headerSize;
        data = Buffer.alloc(fileSize - dataStart);

        if (fs.readSync(fd, data, 0, data.length, dataStart) !== data.length) {
            throw new Error('Не удалось прочитать данные asar для проверки.');
        }
    } finally {
        fs.closeSync(fd);
    }

    let count = 0;

    walkHeader(header.json, '', (filename, node) => {
        if (node.link !== undefined) return;

        if (!node.integrity) {
            throw new Error(`Нет integrity у файла: ${filename}`);
        }

        let buffer;

        if (node.unpacked) {
            const filePath = path.join(unpackedDir, ...filename.split('/'));
            if (!fs.existsSync(filePath)) {
                throw new Error(`Нет распакованного файла: ${filePath}`);
            }
            buffer = fs.readFileSync(filePath);
        } else {
            const offset = Number(node.offset);
            const size = Number(node.size);
            buffer = data.subarray(offset, offset + size);
        }

        if (buffer.length !== Number(node.size)) {
            throw new Error(`Размер не совпадает: ${filename}`);
        }

        verifyIntegrityBuffer(buffer, node.integrity, filename);
        count++;
    });

    return count;
}

function verifyPatchedContent(archivePath, changedFiles) {
    const header = readAsarHeader(archivePath);

    for (const { spec, applied } of changedFiles) {
        const text = readAsarFile(archivePath, header, spec.file).toString('utf8');

        for (const replacement of applied) {
            if (!text.includes(replacement.to)) {
                throw new Error(
                    `После сборки в ${spec.file} нет ожидаемой строки: ${truncate(replacement.to)}`,
                );
            }

            if (text.includes(replacement.from)) {
                throw new Error(
                    `После сборки в ${spec.file} осталась исходная строка: ${truncate(replacement.from)}`,
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Применение строковых замен
// ---------------------------------------------------------------------------

function applyPatchSet(filePath, spec) {
    let text = fs.readFileSync(filePath, 'utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const results = [];

    for (const replacement of spec.replacements) {
        const from = replacement.from.replace(/\n/g, eol);
        const to = replacement.to.replace(/\n/g, eol);
        const count = text.split(from).length - 1;

        if (count > 0) {
            text = text.split(from).join(to);
            results.push({ from, to, status: 'patched', count });
            continue;
        }

        const already = text.split(to).length - 1;

        if (already > 0) {
            results.push({ from, to, status: 'already', count: already });
            continue;
        }

        if (spec.required) {
            throw new Error(
                `Не найден обязательный шаблон в ${filePath}:\n  ${truncate(replacement.from, 200)}`,
            );
        }

        results.push({ from, to, status: 'missing', count: 0 });
    }

    return { text, results };
}

function truncate(value, maxLength = 120) {
    const text = String(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

// ---------------------------------------------------------------------------
// Резервные копии
// ---------------------------------------------------------------------------

function ensureFreeSpace(dir, neededBytes) {
    try {
        const stats = fs.statfsSync(dir);
        const free = Number(stats.bavail) * Number(stats.bsize);

        if (free < neededBytes) {
            throw new Error(
                `Недостаточно места в ${dir}: нужно ~${formatBytes(neededBytes)}, свободно ${formatBytes(free)}.`,
            );
        }
    } catch (error) {
        if (error.code === 'ENOSYS') return;
        throw error;
    }
}

function formatBytes(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function ensureBackup(ctx) {
    if (ctx.dryRun) return null;
    if (ctx.backupDir) return ctx.backupDir;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let dir = path.join(ctx.backupRoot, stamp);
    let index = 1;

    while (fs.existsSync(dir)) {
        dir = path.join(ctx.backupRoot, `${stamp}-${index++}`);
    }

    fs.mkdirSync(dir, { recursive: true });

    ctx.backupDir = dir;
    ctx.backupManifest = {
        version: 1,
        created: new Date().toISOString(),
        installDir: ctx.install ? ctx.install.dir : null,
        sourceDir: ctx.sourceDir || null,
        files: [],
    };

    log.ok(`Папка резервных копий: ${dir}`);
    return dir;
}

function addBackup(ctx, filePath, relativeName) {
    if (ctx.dryRun) return null;

    const backupDir = ensureBackup(ctx);
    const destination = path.join(backupDir, ...relativeName.split('/'));

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    ensureFreeSpace(path.dirname(destination), fs.statSync(filePath).size * 1.2);

    fs.copyFileSync(filePath, destination);

    const originalHash = sha256File(filePath);
    const backupHash = sha256File(destination);

    if (originalHash !== backupHash) {
        throw new Error(`Копия повреждена: ${filePath}`);
    }

    ctx.backupManifest.files.push({
        original: path.resolve(filePath),
        backup: path.relative(backupDir, destination).split(path.sep).join('/'),
        sha256: originalHash,
        size: fs.statSync(filePath).size,
    });

    log.info(`Сохранено в резервную копию: ${relativeName}`);
    return destination;
}

function finalizeBackup(ctx) {
    if (!ctx.backupDir || ctx.dryRun || !ctx.backupManifest) return;

    if (ctx.backupManifest.files.length === 0) {
        try {
            fs.rmSync(ctx.backupDir, { recursive: true, force: true });
        } catch {
            // ignore
        }
        ctx.backupDir = null;
        return;
    }

    const manifestPath = path.join(ctx.backupDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(ctx.backupManifest, null, 2) + '\n', 'utf8');
    log.info(`Манифест резервной копии: ${manifestPath}`);
}

function findLatestBackup(backupRoot) {
    if (!fs.existsSync(backupRoot)) return null;

    const dirs = fs
        .readdirSync(backupRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(backupRoot, entry.name))
        .filter((dir) => fs.existsSync(path.join(dir, 'manifest.json')))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

    return dirs[0] || null;
}

// ---------------------------------------------------------------------------
// exe: RCDATA ElectronAsarIntegrity
// ---------------------------------------------------------------------------

function locateExeIntegrity(exePath) {
    const buffer = fs.readFileSync(exePath);
    const marker = Buffer.from('"file":"resources\\\\app.asar"', 'utf8');
    const markerIndex = buffer.indexOf(marker);

    if (markerIndex < 0) {
        throw new Error('В exe не найден RCDATA integrity JSON (resources\\\\app.asar).');
    }

    const start = buffer.lastIndexOf(Buffer.from('[', 'utf8'), markerIndex);
    if (start < 0) {
        throw new Error('Не удалось найти начало RCDATA integrity JSON в exe.');
    }

    const end = buffer.indexOf(Buffer.from(']', 'utf8'), markerIndex + marker.length);
    if (end < 0) {
        throw new Error('Не удалось найти конец RCDATA integrity JSON в exe.');
    }

    const jsonBuffer = buffer.subarray(start, end + 1);
    let array;

    try {
        array = JSON.parse(jsonBuffer.toString('utf8'));
    } catch (error) {
        throw new Error(`Не удалось разобрать RCDATA integrity JSON в exe: ${error.message}`);
    }

    if (!Array.isArray(array)) {
        throw new Error('RCDATA integrity JSON в exe не является массивом.');
    }

    const entry = array.find(
        (item) =>
            item &&
            typeof item.file === 'string' &&
            item.file.replace(/\\\\/g, '\\').toLowerCase() === 'resources\\app.asar',
    );

    if (!entry) {
        throw new Error('В RCDATA integrity JSON нет записи resources\\app.asar.');
    }

    return { buffer, start, end, jsonBuffer, array, entry };
}

function readExeIntegrityHash(exePath) {
    return locateExeIntegrity(exePath).entry.value;
}

function patchExeIntegrity(exePath, newHash) {
    const location = locateExeIntegrity(exePath);
    const oldValue = location.entry.value;

    location.entry.value = newHash;

    const newJson = JSON.stringify(location.array);
    const newJsonBuffer = Buffer.from(newJson, 'utf8');

    if (newJsonBuffer.length !== location.jsonBuffer.length) {
        throw new Error(
            `Длина RCDATA integrity JSON изменится (${location.jsonBuffer.length} -> ${newJsonBuffer.length}); патч невозможен.`,
        );
    }

    const fd = fs.openSync(exePath, 'r+');

    try {
        const written = fs.writeSync(fd, newJsonBuffer, 0, newJsonBuffer.length, location.start);

        if (written !== newJsonBuffer.length) {
            throw new Error('Не удалось записать новый хэш в exe.');
        }
    } finally {
        fs.closeSync(fd);
    }

    return oldValue;
}

// ---------------------------------------------------------------------------
// Патч исходников
// ---------------------------------------------------------------------------

async function patchSource(ctx) {
    if (!ctx.sourceDir) {
        log.warn('Исходники PulseSync не найдены; пропускаю.');
        return;
    }

    const plans = [];

    for (const spec of SOURCE_PATCHES) {
        const filePath = path.join(ctx.sourceDir, ...spec.file.split('/'));

        if (!fs.existsSync(filePath)) {
            if (spec.required) {
                throw new Error(`Не найден исходный файл: ${filePath}`);
            }
            log.warn(`Пропуск (нет файла): ${spec.file}`);
            continue;
        }

        const { text, results } = applyPatchSet(filePath, spec);
        const applied = results.filter((result) => result.status === 'patched');
        const missing = results.filter((result) => result.status === 'missing');

        for (const result of missing) {
            log.warn(`  шаблон не найден (${spec.file}): ${truncate(result.from)}`);
        }

        if (applied.length > 0) {
            plans.push({ spec, filePath, text, applied });
        } else if (results.some((result) => result.status === 'already')) {
            log.info(`Уже пропатчен: ${spec.file}`);
        }
    }

    if (plans.length === 0) {
        log.ok('Исходники уже пропатчены.');
        return;
    }

    log.info(`Исходники: будет изменено файлов: ${plans.length}`);

    if (ctx.dryRun) {
        for (const plan of plans) {
            log.info(`[dry-run] ${plan.spec.file}`);
        }
        return;
    }

    for (const plan of plans) {
        addBackup(ctx, plan.filePath, `source/${plan.spec.file}`);
    }

    for (const plan of plans) {
        fs.writeFileSync(plan.filePath, plan.text, 'utf8');

        const check = fs.readFileSync(plan.filePath, 'utf8');

        for (const replacement of plan.applied) {
            if (!check.includes(replacement.to)) {
                throw new Error(`Проверка после записи не удалась: ${plan.spec.file}`);
            }
            if (check.includes(replacement.from)) {
                throw new Error(`После записи осталась исходная строка: ${plan.spec.file}`);
            }
        }

        log.ok(`Пропатчен ${plan.spec.file} (${plan.applied.length})`);
    }
}

// ---------------------------------------------------------------------------
// Патч установленного мода
// ---------------------------------------------------------------------------

async function patchInstalled(ctx) {
    const { asar: asarPath, unpacked: unpackedPath, exe: exePath } = ctx.install;

    log.info(`Установленный мод: ${ctx.install.dir}`);
    log.info(`app.asar: ${asarPath}`);
    log.info(`exe: ${exePath}`);

    assertExeWritable(exePath);

    const oldHeader = readAsarHeader(asarPath);
    const oldStats = analyzeHeader(oldHeader);
    const oldHash = sha256(oldHeader.headerString);
    const oldExeHash = readExeIntegrityHash(exePath);

    log.info(`Файлов в asar: ${oldStats.files}; распакованных: ${oldStats.unpacked}; каталогов: ${oldStats.dirs}`);
    log.info(`Хэш заголовка asar: ${oldHash}`);
    log.info(`Хэш в exe: ${oldExeHash}`);

    if (oldExeHash !== oldHash) {
        log.warn('Хэш в exe не совпадает с текущим app.asar (возможно, мод уже модифицировался).');
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsesync-unlock-'));
    const extractDir = path.join(tempDir, 'app');

    try {
        log.info('Распаковка app.asar...');
        await extractAsar(ctx, asarPath, extractDir);

        const changed = [];

        for (const spec of INSTALLED_PATCHES) {
            const filePath = path.join(extractDir, ...spec.file.split('/'));

            if (!fs.existsSync(filePath)) {
                if (spec.required) {
                    throw new Error(`В asar нет обязательного файла: ${spec.file}`);
                }
                log.warn(`Пропуск (нет файла): ${spec.file}`);
                continue;
            }

            const { text, results } = applyPatchSet(filePath, spec);
            const applied = results.filter((result) => result.status === 'patched');
            const missing = results.filter((result) => result.status === 'missing');

            for (const result of missing) {
                log.warn(`  шаблон не найден (${spec.file}): ${truncate(result.from)}`);
            }

            if (applied.length > 0) {
                fs.writeFileSync(filePath, text, 'utf8');
                changed.push({ spec, applied });
                log.ok(`Пропатчен ${spec.file} (${applied.length})`);
            } else if (results.some((result) => result.status === 'already')) {
                log.info(`Уже пропатчен: ${spec.file}`);
            }
        }

        let newAsarPath = null;
        let newHash = oldHash;

        if (changed.length > 0) {
            newAsarPath = path.join(tempDir, 'app.asar');

            log.info('Сборка нового app.asar...');
            await packAsar(ctx, extractDir, newAsarPath);

            log.info('Проверка нового asar...');
            const newHeader = readAsarHeader(newAsarPath);
            const newStats = analyzeHeader(newHeader);

            if (
                newStats.files !== oldStats.files ||
                newStats.dirs !== oldStats.dirs ||
                newStats.links !== oldStats.links ||
                newStats.unpacked !== oldStats.unpacked
            ) {
                throw new Error(
                    `Структура нового asar отличается от исходной: файлов ${newStats.files}/${oldStats.files}, ` +
                        `каталогов ${newStats.dirs}/${oldStats.dirs}, распакованных ${newStats.unpacked}/${oldStats.unpacked}.`,
                );
            }

            if (newStats.withIntegrity !== newStats.files) {
                throw new Error('В новом asar не у всех файлов есть integrity.');
            }

            for (const unpackedFile of newStats.unpackedPaths) {
                const newFile = path.join(newAsarPath + '.unpacked', ...unpackedFile.split('/'));
                const oldFile = path.join(unpackedPath, ...unpackedFile.split('/'));

                if (!fs.existsSync(newFile)) {
                    throw new Error(`В новом asar.unpacked нет файла: ${unpackedFile}`);
                }
                if (!fs.existsSync(oldFile)) {
                    throw new Error(`В установленном app.asar.unpacked нет файла: ${unpackedFile}`);
                }

                if (!fs.readFileSync(newFile).equals(fs.readFileSync(oldFile))) {
                    throw new Error(`Распакованный файл изменился: ${unpackedFile}`);
                }
            }

            const verifiedCount = verifyArchiveIntegrity(newAsarPath, newHeader, unpackedPath);
            log.ok(`Проверена целостность ${verifiedCount} файлов нового asar.`);

            verifyPatchedContent(newAsarPath, changed);

            newHash = sha256(newHeader.headerString);
            log.ok(`Новый asar готов: ${formatBytes(fs.statSync(newAsarPath).size)}`);
            log.info(`Новый хэш заголовка: ${newHash}`);

            if (newHash === oldHash) {
                log.warn('Хэш заголовка не изменился, хотя содержимое было изменено.');
            }
        } else {
            log.ok('Все патчи в app.asar уже применены.');
        }

        if (ctx.dryRun) {
            log.info(
                changed.length > 0
                    ? '[dry-run] app.asar и exe не изменены.'
                    : '[dry-run] изменений в app.asar нет.',
            );
            return;
        }

        if (changed.length > 0) {
            addBackup(ctx, asarPath, 'install/app.asar');
            addBackup(ctx, exePath, `install/${path.basename(exePath)}`);

            const backupAsar = path.join(ctx.backupDir, 'install', 'app.asar');
            const backupExe = path.join(ctx.backupDir, 'install', path.basename(exePath));

            try {
                log.info('Замена app.asar...');
                replaceFile(newAsarPath, asarPath);

                log.info('Обновление хэша в exe...');
                const oldValue = patchExeIntegrity(exePath, newHash);
                log.ok(`Хэш в exe обновлён: ${oldValue} -> ${newHash}`);

                const installedHash = hashAsarHeader(asarPath);
                const installedExeHash = readExeIntegrityHash(exePath);

                if (installedHash !== newHash) {
                    throw new Error('Хэш установленного app.asar не совпадает с ожидаемым.');
                }
                if (installedExeHash !== newHash) {
                    throw new Error('Хэш в exe не совпадает с app.asar после обновления.');
                }

                log.ok('Проверка после установки пройдена.');
            } catch (error) {
                log.err('Ошибка применения. Восстанавливаю app.asar и exe из резервной копии...');

                try {
                    fs.copyFileSync(backupAsar, asarPath);
                    fs.copyFileSync(backupExe, exePath);
                    log.ok('Резервные копии восстановлены.');
                } catch (restoreError) {
                    log.err(`Не удалось восстановить автоматически: ${restoreError.message}`);
                    log.err(`Восстановите вручную из ${ctx.backupDir}`);
                }

                throw error;
            }
        } else if (oldExeHash !== oldHash) {
            log.warn('Патчи уже применены, но хэш в exe не совпадает. Исправляю...');
            addBackup(ctx, exePath, `install/${path.basename(exePath)}`);

            const oldValue = patchExeIntegrity(exePath, oldHash);
            log.ok(`Хэш в exe обновлён: ${oldValue} -> ${oldHash}`);

            if (readExeIntegrityHash(exePath) !== oldHash) {
                throw new Error('Не удалось проверить новый хэш в exe.');
            }
        } else {
            log.ok('Хэш в exe корректен.');
        }
    } finally {
        if (ctx.keepTemp) {
            log.info(`Временная папка сохранена: ${tempDir}`);
        } else {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch {
                // ignore
            }
        }
    }
}

function replaceFile(sourcePath, destinationPath) {
    const temporaryPath = destinationPath + '.pulsesync-new';
    fs.copyFileSync(sourcePath, temporaryPath);

    try {
        fs.renameSync(temporaryPath, destinationPath);
    } catch (error) {
        try {
            fs.copyFileSync(temporaryPath, destinationPath);
            fs.unlinkSync(temporaryPath);
        } catch (fallbackError) {
            throw new Error(
                `Не удалось заменить ${destinationPath}: ${error.message}; ${fallbackError.message}`,
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Восстановление
// ---------------------------------------------------------------------------

async function restoreBackup(ctx, explicitDir) {
    const backupDir = explicitDir ? path.resolve(explicitDir) : findLatestBackup(ctx.backupRoot);

    if (!backupDir) {
        throw new Error(
            `Резервные копии не найдены в ${ctx.backupRoot}. Укажите папку: --restore "путь\\к\\копии".`,
        );
    }

    const manifestPath = path.join(backupDir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
        throw new Error(`В ${backupDir} нет manifest.json.`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0) {
        throw new Error('Манифест резервной копии пуст или повреждён.');
    }

    log.info(`Восстановление из: ${backupDir}`);

    for (const file of manifest.files) {
        if (/\.exe$/i.test(file.original)) {
            assertExeWritable(file.original);
        }
    }

    for (const file of manifest.files) {
        const backupPath = path.join(backupDir, ...file.backup.split('/'));

        if (!fs.existsSync(backupPath)) {
            throw new Error(`Нет файла резервной копии: ${backupPath}`);
        }

        const hash = sha256File(backupPath);

        if (hash !== file.sha256) {
            throw new Error(`Хэш резервной копии не совпадает: ${backupPath}`);
        }

        if (ctx.dryRun) {
            log.info(`[dry-run] восстановил бы ${file.original}`);
            continue;
        }

        fs.copyFileSync(backupPath, file.original);
        log.ok(`Восстановлен ${file.original}`);
    }

    log.ok('Восстановление завершено.');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
        printHelp();
        return;
    }

    if (args.version) {
        console.log(VERSION);
        return;
    }

    if (args.installedOnly && args.sourceOnly) {
        throw new Error('Нельзя одновременно указать --installed-only и --source-only.');
    }

    const ctx = {
        args,
        dryRun: Boolean(args.dryRun),
        keepTemp: Boolean(args.keepTemp),
        sourceDir: args.sourceDir ? path.resolve(args.sourceDir) : findSourceDir(),
        backupRoot: args.backupDir
            ? path.resolve(args.backupDir)
            : path.join(SCRIPT_DIR, BACKUP_FOLDER_NAME),
        backupDir: null,
        backupManifest: null,
        asar: null,
        install: null,
    };

    if (args.restore) {
        await restoreBackup(ctx, args.restoreDir);
        return;
    }

    if (!args.sourceOnly) {
        ctx.install = findInstall(args.installDir);
        assertExeWritable(ctx.install.exe);
    }

    if (!args.installedOnly) {
        if (!ctx.sourceDir) {
            log.warn('Исходники PulseSync не найдены; патч исходников будет пропущен.');
        } else if (
            !fs.existsSync(path.join(ctx.sourceDir, 'src', 'main', 'lib', 'pulsesync', 'PulseSyncManager.js'))
        ) {
            log.warn(`В ${ctx.sourceDir} нет исходников PulseSync; патч исходников будет пропущен.`);
            ctx.sourceDir = null;
        }
    }

    if (!args.sourceOnly) {
        ctx.asar = await loadAsarModule(args.asarModule);

        if (!ctx.asar) {
            log.warn('@electron/asar не найден локально. Будет использован npx (нужен интернет).');
        }
    }

    log.info(`PulseSync Premium Unlock v${VERSION}`);
    if (ctx.dryRun) log.info('Режим --dry-run: файлы изменяться не будут.');

    if (!args.installedOnly) {
        await patchSource(ctx);
    }

    if (!args.sourceOnly) {
        await patchInstalled(ctx);
    }

    finalizeBackup(ctx);

    log.ok('Готово. Запустите Яндекс Музыку заново.');
}

main().catch((error) => {
    log.err(error && error.message ? error.message : String(error));

    if (process.env.DEBUG && error && error.stack) {
        console.error(error.stack);
    }

    process.exitCode = 1;
});
