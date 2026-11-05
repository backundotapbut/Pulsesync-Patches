#!/usr/bin/env node
/**
 * VibeColorizer Patch
 *
 * Добавляет в PulseSync API негласный оверрайд цветов волны:
 *   --pulsesync-vibe-custom-colors  (CSS-переменная на <html>)
 *
 * Значение переменной — JSON с шестью HSL-стопами:
 *   { topStart:{h,s,l}, middleStart:{h,s,l}, bottomStart:{h,s,l},
 *     topEnd:{h,s,l},  middleEnd:{h,s,l},  bottomEnd:{h,s,l} }
 *
 * Патч затрагивает:
 *   1) renderer-чанк с VibeWidgetAnimation (читает CSS-переменную);
 *   2) воркер vibeAnimation.js (поддержка 6 независимых стопов);
 *   3) integrity-хэш app.asar в exe (иначе Electron не загрузит asar).
 *
 * Использование:
 *   node patch-vibe-colors.js
 *   node patch-vibe-colors.js --dry-run
 *   node patch-vibe-colors.js --installed-only
 *   node patch-vibe-colors.js --source-only
 *   node patch-vibe-colors.js --no-sync
 *   node patch-vibe-colors.js --restore
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

const VERSION = '2.0.0';
const SCRIPT_DIR = __dirname;
const ASAR_UNPACK_DIR = 'node_modules/{@img,sharp}';
const BACKUP_FOLDER_NAME = 'vibe-colors-backup';
const CSS_VAR = '--pulsesync-vibe-custom-colors';

const log = {
    info: (...args) => console.log('[i]', ...args),
    ok: (...args) => console.log('[+]', ...args),
    warn: (...args) => console.log('[!]', ...args),
    err: (...args) => console.error('[-]', ...args),
};

// ---------------------------------------------------------------------------
// Патчи
// ---------------------------------------------------------------------------

// Функция getPulseSyncAnimationSettings: `const x=()=>{ if(!window.VIBE_ANIMATION_USE_VIBE_WIDGET_COLORS?.()) ... }`
const CHUNK_PATTERN =
    /(\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*\(\)\s*=>\s*\{\s*|function\s+[A-Za-z_$][\w$]*\s*\(\)\s*\{\s*)(if\s*\(\s*!\s*window\.VIBE_ANIMATION_USE_VIBE_WIDGET_COLORS\?\.\(\)\s*\))/;

const CHUNK_INJECTION =
    'const __psVibeColorsRaw=document.documentElement.style.getPropertyValue(' +
    JSON.stringify(CSS_VAR) +
    ');if(__psVibeColorsRaw){try{const __psVibeColors=JSON.parse(__psVibeColorsRaw);' +
    'if(__psVibeColors&&__psVibeColors.topStart&&__psVibeColors.middleStart&&__psVibeColors.bottomStart&&' +
    '__psVibeColors.topEnd&&__psVibeColors.middleEnd&&__psVibeColors.bottomEnd)return{customColors:__psVibeColors}}' +
    'catch(__psVibeColorsError){}}';

// Класс цвета: update(t, e) -> ветка объекта.
const COLOR_PATTERN =
    /(if\s*\(\s*["']object["']\s*==\s*typeof\s+([A-Za-z_$][\w$]*)\s*\)\s*\{\s*)(const\s*\{\s*top\s*:)/;

const COLOR_REPLACEMENT = (match, prefix, variable, rest) =>
    prefix +
    'const __ps6=' +
    variable +
    ';' +
    'if(__ps6&&__ps6.topStart&&__ps6.middleStart&&__ps6.bottomStart&&__ps6.topEnd&&__ps6.middleEnd&&__ps6.bottomEnd){' +
    'this.topStart.update(__ps6.topStart.h,__ps6.topStart.s,__ps6.topStart.l);' +
    'this.topEnd.update(__ps6.topEnd.h,__ps6.topEnd.s,__ps6.topEnd.l);' +
    'this.middleStart.update(__ps6.middleStart.h,__ps6.middleStart.s,__ps6.middleStart.l);' +
    'this.middleEnd.update(__ps6.middleEnd.h,__ps6.middleEnd.s,__ps6.middleEnd.l);' +
    'this.bottomStart.update(__ps6.bottomStart.h,__ps6.bottomStart.s,__ps6.bottomStart.l);' +
    'this.bottomEnd.update(__ps6.bottomEnd.h,__ps6.bottomEnd.s,__ps6.bottomEnd.l);return}' +
    rest;

// applySettings -> нормализация customColors.
const APPLY_PATTERN =
    /([A-Za-z_$][\w$]*)\s*&&\s*\(\s*([A-Za-z_$][\w$]*)\.customColors\s*=\s*\{\s*top\s*:\s*([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\.top\s*\)\s*,\s*middle\s*:\s*\3\s*\(\s*\4\.middle\s*\)\s*,\s*bottom\s*:\s*\3\s*\(\s*\4\.bottom\s*\)\s*\}/;

const APPLY_REPLACEMENT = (match, customVariable, outputVariable, normalize, customVariableAgain) => {
    const variable = customVariableAgain;
    return (
        customVariable +
        '&&(' +
        outputVariable +
        '.customColors=' +
        variable +
        '.topStart?' +
        '{topStart:' + normalize + '(' + variable + '.topStart),' +
        'middleStart:' + normalize + '(' + variable + '.middleStart),' +
        'bottomStart:' + normalize + '(' + variable + '.bottomStart),' +
        'topEnd:' + normalize + '(' + variable + '.topEnd),' +
        'middleEnd:' + normalize + '(' + variable + '.middleEnd),' +
        'bottomEnd:' + normalize + '(' + variable + '.bottomEnd)}' +
        ':{top:' + normalize + '(' + variable + '.top),' +
        'middle:' + normalize + '(' + variable + '.middle),' +
        'bottom:' + normalize + '(' + variable + '.bottom)}'
    );
};

// ---------------------------------------------------------------------------
// Аргументы
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--version' || arg === '-v') args.version = true;
        else if (arg === '--dry-run') args.dryRun = true;
        else if (arg === '--installed-only') args.installedOnly = true;
        else if (arg === '--source-only') args.sourceOnly = true;
        else if (arg === '--no-sync') args.noSync = true;
        else if (arg === '--keep-temp') args.keepTemp = true;
        else if (arg === '--restore') args.restore = true;
        else if (arg === '--install-dir') args.installDir = argv[++i];
        else if (arg === '--source-dir') args.sourceDir = argv[++i];
        else if (arg.startsWith('-')) throw new Error(`Неизвестная опция: ${arg}`);
        else args._.push(arg);
    }
    return args;
}

function printHelp() {
    console.log(`VibeColorizer Patch v${VERSION}

Добавляет в установленный PulseSync поддержку CSS-переменной
${CSS_VAR} для управления цветами волны из аддонов.

Использование:
  node patch-vibe-colors.js [опции]

Опции:
  --dry-run          Показать, что будет изменено, но не записывать файлы
  --installed-only   Патчить только установленный мод (app.asar)
  --source-only      Патчить только исходники рядом со скриптом
  --no-sync          Не запускать sync-pulsesync-state.js после патча
  --restore          Восстановить последнюю резервную копию
  --install-dir DIR  Папка установленной Яндекс Музыки
  --source-dir DIR   Папка исходников PulseSync (с подпапкой src)
  --keep-temp        Не удалять временную папку распаковки
  --help             Эта справка
`);
}

// ---------------------------------------------------------------------------
// Поиск установленного мода и исходников
// ---------------------------------------------------------------------------

function findSourceDir(explicitDir) {
    const candidates = [];
    if (explicitDir) candidates.push(path.resolve(explicitDir));
    candidates.push(SCRIPT_DIR, process.cwd());

    for (const dir of candidates) {
        if (fs.existsSync(path.join(dir, 'src', 'main', 'lib', 'workers', 'vibeAnimation.js'))) {
            return dir;
        }
    }
    return null;
}

function findInstall(explicitDir) {
    const candidates = [];
    if (explicitDir) candidates.push(path.resolve(explicitDir));
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'YandexMusic'));
    if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'YandexMusic'));
    if (process.env['ProgramFiles(x86)']) candidates.push(path.join(process.env['ProgramFiles(x86)'], 'YandexMusic'));
    if (process.env.USERPROFILE) candidates.push(path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Programs', 'YandexMusic'));

    const seen = new Set();
    for (const dir of candidates) {
        if (!dir) continue;
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
    throw new Error('Не найден resources\\app.asar. Укажите --install-dir.');
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
            } catch {}
            return { fullPath, name: entry.name, size };
        })
        .sort((a, b) => b.size - a.size);

    if (files.length === 0) throw new Error(`В папке ${installDir} не найден .exe Яндекс Музыки.`);
    const preferred = files.find((file) => /яндекс|yandex|music|музык/i.test(file.name));
    return (preferred || files[0]).fullPath;
}

function assertExeWritable(exePath) {
    try {
        const fd = fs.openSync(exePath, 'r+');
        fs.closeSync(fd);
    } catch (error) {
        if (['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) {
            throw new Error(`Файл ${exePath} заблокирован. Закройте Яндекс Музыку и повторите.`);
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
                if (fs.statSync(resolved).isDirectory()) add(path.join(resolved, 'lib', 'asar.js'));
            } catch {}
        } catch {}
    }

    const npxRoot = path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx');
    if (fs.existsSync(npxRoot)) {
        for (const dir of fs.readdirSync(npxRoot)) {
            add(path.join(npxRoot, dir, 'node_modules', '@electron', 'asar', 'lib', 'asar.js'));
        }
    }

    if (process.env.APPDATA) add(path.join(process.env.APPDATA, 'npm', 'node_modules', '@electron', 'asar', 'lib', 'asar.js'));

    const seen = new Set();
    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        if (!fs.existsSync(resolved)) continue;
        try {
            const imported = await import(pathToFileURL(resolved).href);
            const mod = imported.default && typeof imported.default.extractAll === 'function' ? imported.default : imported;
            if (
                typeof mod.extractAll === 'function' &&
                typeof mod.createPackageWithOptions === 'function' &&
                typeof mod.getRawHeader === 'function'
            ) {
                log.info(`@electron/asar: ${resolved}`);
                return { mod, modulePath: resolved };
            }
        } catch {}
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
        if (result.status !== 0) throw new Error(`npx @electron/asar завершился с кодом ${result.status}.`);
        return;
    }
    const result = spawnSync('npx', npxArgs, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`npx @electron/asar завершился с кодом ${result.status}.`);
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
        await ctx.asar.mod.createPackageWithOptions(sourceDir, destination, { unpackDir: ASAR_UNPACK_DIR });
        return;
    }
    runAsarCli(['pack', sourceDir, destination, '--unpack-dir', ASAR_UNPACK_DIR]);
}

// ---------------------------------------------------------------------------
// Работа с asar
// ---------------------------------------------------------------------------

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readAsarHeader(archivePath) {
    const fd = fs.openSync(archivePath, 'r');
    try {
        const sizeBuffer = Buffer.alloc(8);
        if (fs.readSync(fd, sizeBuffer, 0, 8, 0) !== 8) throw new Error('Не удалось прочитать размер заголовка asar.');
        const headerSize = sizeBuffer.readUInt32LE(4);
        const headerBuffer = Buffer.alloc(headerSize);
        if (fs.readSync(fd, headerBuffer, 0, headerSize, 8) !== headerSize) throw new Error('Не удалось прочитать заголовок asar.');
        const jsonLength = headerBuffer.readUInt32LE(4);
        const headerString = headerBuffer.subarray(8, 8 + jsonLength);
        const json = JSON.parse(headerString.toString('utf8'));
        return { headerSize, jsonLength, headerString, json, fileSize: fs.fstatSync(fd).size };
    } finally {
        fs.closeSync(fd);
    }
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

function getHeaderNode(header, filename) {
    let node = header.json;
    for (const part of filename.split('/')) {
        if (!node.files || !node.files[part]) throw new Error(`В asar нет файла: ${filename}`);
        node = node.files[part];
    }
    return node;
}

function readAsarFile(archivePath, header, filename) {
    const node = getHeaderNode(header, filename);
    if (node.link !== undefined) throw new Error(`Символические ссылки не поддерживаются: ${filename}`);
    if (node.unpacked) return fs.readFileSync(path.join(archivePath + '.unpacked', ...filename.split('/')));
    const offset = Number(node.offset);
    const size = Number(node.size);
    const fd = fs.openSync(archivePath, 'r');
    try {
        const buffer = Buffer.alloc(size);
        const position = 8 + header.headerSize + offset;
        const read = fs.readSync(fd, buffer, 0, size, position);
        if (read !== size) throw new Error(`Не удалось прочитать файл из asar: ${filename}`);
        return buffer;
    } finally {
        fs.closeSync(fd);
    }
}

function verifyIntegrityBuffer(buffer, integrity, label) {
    const hash = sha256(buffer);
    if (hash !== integrity.hash) throw new Error(`SHA256 не совпадает: ${label}`);
    const blockSize = Number(integrity.blockSize) || 4 * 1024 * 1024;
    const blocks = [];
    for (let offset = 0; offset < buffer.length; offset += blockSize) {
        blocks.push(sha256(buffer.subarray(offset, Math.min(offset + blockSize, buffer.length))));
    }
    if (buffer.length === 0) blocks.push(sha256(buffer));
    if (blocks.length !== integrity.blocks.length) throw new Error(`Количество блоков не совпадает: ${label}`);
    for (let index = 0; index < blocks.length; index++) {
        if (blocks[index] !== integrity.blocks[index]) throw new Error(`Блок ${index} не совпадает: ${label}`);
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
        if (!node.integrity) throw new Error(`Нет integrity у файла: ${filename}`);
        let buffer;
        if (node.unpacked) {
            const filePath = path.join(unpackedDir, ...filename.split('/'));
            if (!fs.existsSync(filePath)) throw new Error(`Нет распакованного файла: ${filePath}`);
            buffer = fs.readFileSync(filePath);
        } else {
            const offset = Number(node.offset);
            const size = Number(node.size);
            buffer = data.subarray(offset, offset + size);
        }
        if (buffer.length !== Number(node.size)) throw new Error(`Размер не совпадает: ${filename}`);
        verifyIntegrityBuffer(buffer, node.integrity, filename);
        count++;
    });
    return count;
}

// ---------------------------------------------------------------------------
// Integrity-хэш в exe (RCDATA ElectronAsarIntegrity)
// ---------------------------------------------------------------------------

function locateExeIntegrity(exePath) {
    const buffer = fs.readFileSync(exePath);
    const marker = Buffer.from('"file":"resources\\\\app.asar"', 'utf8');
    const markerIndex = buffer.indexOf(marker);
    if (markerIndex < 0) throw new Error('В exe не найден RCDATA integrity JSON (resources\\\\app.asar).');

    const start = buffer.lastIndexOf(Buffer.from('[', 'utf8'), markerIndex);
    if (start < 0) throw new Error('Не удалось найти начало RCDATA integrity JSON в exe.');

    const end = buffer.indexOf(Buffer.from(']', 'utf8'), markerIndex + marker.length);
    if (end < 0) throw new Error('Не удалось найти конец RCDATA integrity JSON в exe.');

    const jsonBuffer = buffer.subarray(start, end + 1);
    let array;
    try {
        array = JSON.parse(jsonBuffer.toString('utf8'));
    } catch (error) {
        throw new Error(`Не удалось разобрать RCDATA integrity JSON в exe: ${error.message}`);
    }

    if (!Array.isArray(array)) throw new Error('RCDATA integrity JSON в exe не является массивом.');

    const entry = array.find(
        (item) =>
            item &&
            typeof item.file === 'string' &&
            item.file.replace(/\\\\/g, '\\').toLowerCase() === 'resources\\app.asar',
    );
    if (!entry) throw new Error('В RCDATA integrity JSON нет записи resources\\app.asar.');

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
        if (written !== newJsonBuffer.length) throw new Error('Не удалось записать новый хэш в exe.');
    } finally {
        fs.closeSync(fd);
    }
    return oldValue;
}

// ---------------------------------------------------------------------------
// Патч файлов
// ---------------------------------------------------------------------------

function applyPatch(text, regex, replacement, marker) {
    if (text.includes(marker)) return { text, status: 'already' };
    const match = text.match(regex);
    if (!match) return { text, status: 'missing' };
    const replaced = text.replace(regex, replacement);
    if (replaced === text) return { text, status: 'missing' };
    return { text: replaced, status: 'patched' };
}

function patchWorkerFile(filePath, write = true) {
    let text = fs.readFileSync(filePath, 'utf8');
    const statuses = [];

    let result = applyPatch(text, COLOR_PATTERN, COLOR_REPLACEMENT, 'const __ps6=');
    statuses.push(result.status === 'already' ? 'already' : result.status);
    text = result.text;

    result = applyPatch(text, APPLY_PATTERN, APPLY_REPLACEMENT, '.topStart?{topStart:');
    statuses.push(result.status === 'already' ? 'already' : result.status);
    text = result.text;

    if (statuses.includes('missing')) return 'missing';
    if (statuses.includes('patched')) {
        if (write) fs.writeFileSync(filePath, text, 'utf8');
        return 'patched';
    }
    return 'already';
}

function walkJsFiles(rootDir, callback) {
    if (!fs.existsSync(rootDir)) return;
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
        const fullPath = path.join(rootDir, entry.name);
        if (entry.isDirectory()) walkJsFiles(fullPath, callback);
        else if (entry.isFile() && entry.name.endsWith('.js')) callback(fullPath);
    }
}

function patchRendererTree(appRoot, options = {}) {
    const write = options.write !== false;
    const ctx = options.ctx || null;
    const backupPrefix = options.backupPrefix || '';
    let found = 0;
    let patched = 0;
    let already = 0;
    let missing = 0;
    const matchedFiles = [];
    const patchedFiles = [];

    walkJsFiles(path.join(appRoot, 'app', '_next'), (filePath) => {
        let text;
        try {
            text = fs.readFileSync(filePath, 'utf8');
        } catch {
            return;
        }
        if (!text.includes('VIBE_ANIMATION_USE_VIBE_WIDGET_COLORS')) return;
        if (!CHUNK_PATTERN.test(text) && !text.includes('__psVibeColorsRaw')) return;
        found++;
        const relative = path.relative(appRoot, filePath);
        matchedFiles.push(relative);

        const result = applyPatch(text, CHUNK_PATTERN, `$1${CHUNK_INJECTION}$2`, '__psVibeColorsRaw');
        if (result.status === 'patched') {
            patched++;
            patchedFiles.push(relative);
            if (ctx && !ctx.dryRun) {
                addBackup(ctx, filePath, `${backupPrefix}${relative.split(path.sep).join('/')}`);
            }
            if (write) fs.writeFileSync(filePath, result.text, 'utf8');
        } else if (result.status === 'already') already++;
        else missing++;
    });

    return { found, patched, already, missing, matchedFiles, patchedFiles };
}

// ---------------------------------------------------------------------------
// Резервные копии
// ---------------------------------------------------------------------------

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

function ensureBackup(ctx) {
    if (ctx.dryRun) return null;
    if (ctx.backupDir) return ctx.backupDir;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let dir = path.join(ctx.backupRoot, stamp);
    let index = 1;
    while (fs.existsSync(dir)) dir = path.join(ctx.backupRoot, `${stamp}-${index++}`);

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
    fs.copyFileSync(filePath, destination);

    const originalHash = sha256File(filePath);
    const backupHash = sha256File(destination);
    if (originalHash !== backupHash) throw new Error(`Копия повреждена: ${filePath}`);

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
        } catch {}
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
            throw new Error(`Не удалось заменить ${destinationPath}: ${error.message}; ${fallbackError.message}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Патч исходников
// ---------------------------------------------------------------------------

function patchSource(ctx) {
    if (!ctx.sourceDir) {
        log.warn('Исходники не найдены; патч исходников пропущен.');
        return;
    }

    const appRoot = path.join(ctx.sourceDir, 'src');
    const workerPath = path.join(appRoot, 'main', 'lib', 'workers', 'vibeAnimation.js');

    const renderer = patchRendererTree(appRoot, {
        write: !ctx.dryRun,
        ctx,
        backupPrefix: 'source/src/',
    });
    log.info(
        `Исходники: renderer — найдено ${renderer.found}, пропатчено ${renderer.patched}, уже ${renderer.already}, ошибок ${renderer.missing}`,
    );
    if (ctx.dryRun) {
        for (const rel of renderer.matchedFiles) log.info(`[dry-run] ${path.join('src', rel)}`);
    }
    if (renderer.missing > 0) {
        log.warn(`Исходники: ${renderer.missing} файл(ов) с шаблоном не удалось пропатчить.`);
    }

    if (fs.existsSync(workerPath)) {
        const workerStatusPreview = patchWorkerFile(workerPath, false);
        if (workerStatusPreview === 'patched' && !ctx.dryRun) {
            addBackup(ctx, workerPath, 'source/main/lib/workers/vibeAnimation.js');
        }
        const workerStatus = workerStatusPreview === 'patched' && !ctx.dryRun ? patchWorkerFile(workerPath, true) : workerStatusPreview;
        log[workerStatus === 'missing' ? 'warn' : 'ok'](
            `Исходники: воркер — ${
                workerStatus === 'patched' ? 'пропатчен' : workerStatus === 'already' ? 'уже пропатчен' : 'шаблон не найден'
            }`,
        );
    } else {
        log.warn(`Исходники: не найден ${workerPath}`);
    }
}

// ---------------------------------------------------------------------------
// Патч установленного мода
// ---------------------------------------------------------------------------

async function patchInstalled(ctx) {
    const { asar: asarPath, unpacked: unpackedPath, exe: exePath } = ctx.install;

    log.info(`Установленный мод: ${ctx.install.dir}`);
    log.info(`exe: ${exePath}`);
    assertExeWritable(exePath);

    const oldHeader = readAsarHeader(asarPath);
    const oldHash = sha256(oldHeader.headerString);
    let oldExeHash = '(не удалось прочитать)';
    try {
        oldExeHash = readExeIntegrityHash(exePath);
    } catch (error) {
        log.warn(`Не удалось прочитать integrity-хэш из exe: ${error.message}`);
    }

    log.info(`Хэш заголовка app.asar: ${oldHash}`);
    if (oldExeHash !== '(не удалось прочитать)' && oldExeHash !== oldHash) {
        log.warn(`Хэш в exe не совпадает с текущим app.asar (${oldExeHash}).`);
        log.warn('Это нормально, если asar уже патчился сторонним скриптом; новый хэш будет записан.');
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsesync-vibe-'));
    const extractDir = path.join(tempDir, 'app');
    try {
        log.info('Распаковка app.asar...');
        await extractAsar(ctx, asarPath, extractDir);

        const renderer = patchRendererTree(extractDir);
        for (const rel of renderer.matchedFiles) {
            log.info(`Renderer-чанк: ${rel.split(path.sep).join('/')}`);
        }
        log.info(
            `Renderer: найдено ${renderer.found}, пропатчено ${renderer.patched}, уже ${renderer.already}, ошибок ${renderer.missing}`,
        );

        const workerRel = path.join('main', 'lib', 'workers', 'vibeAnimation.js');
        const workerPath = path.join(extractDir, workerRel);
        if (!fs.existsSync(workerPath)) throw new Error(`В asar нет файла: ${workerRel}`);
        const workerStatus = patchWorkerFile(workerPath);
        log[workerStatus === 'missing' ? 'warn' : 'ok'](
            `Worker: ${workerStatus === 'patched' ? 'пропатчен' : workerStatus === 'already' ? 'уже пропатчен' : 'шаблон не найден'}`,
        );

        if (renderer.patched === 0 && renderer.already === 0 && workerStatus !== 'patched') {
            log.ok('Все патчи уже применены.');
            return;
        }
        if (renderer.missing > 0 || workerStatus === 'missing') {
            throw new Error('Не все обязательные шаблоны найдены. Патч отменён, app.asar не изменён.');
        }

        const newAsarPath = path.join(tempDir, 'app.asar');
        log.info('Сборка нового app.asar...');
        await packAsar(ctx, extractDir, newAsarPath);

        const newHeader = readAsarHeader(newAsarPath);
        const newHash = sha256(newHeader.headerString);

        log.info('Проверка integrity нового asar...');
        const verifiedCount = verifyArchiveIntegrity(newAsarPath, newHeader, unpackedPath);
        log.ok(`Проверено файлов: ${verifiedCount}`);

        if (ctx.dryRun) {
            log.info(`[dry-run] app.asar не изменён. Новый хэш был бы: ${newHash}`);
            return;
        }

        addBackup(ctx, asarPath, 'install/app.asar');
        addBackup(ctx, exePath, `install/${path.basename(exePath)}`);

        replaceFile(newAsarPath, asarPath);
        log.ok('app.asar обновлён.');

        patchExeIntegrity(exePath, newHash);
        log.ok('Integrity-хэш в exe обновлён.');
        log.info(`Новый хэш заголовка: ${newHash}`);
    } finally {
        if (!ctx.keepTemp) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch {}
        }
    }
}

// ---------------------------------------------------------------------------
// Восстановление
// ---------------------------------------------------------------------------

function restoreLatestBackup(ctx) {
    const latest = findLatestBackup(ctx.backupRoot);
    if (!latest) throw new Error(`Резервные копии не найдены в ${ctx.backupRoot}`);

    const manifestPath = path.join(latest, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    log.info(`Восстановление из ${latest}`);

    for (const entry of manifest.files) {
        const backupPath = path.join(latest, ...entry.backup.split('/'));
        if (!fs.existsSync(backupPath)) {
            log.warn(`Нет файла резервной копии: ${backupPath}`);
            continue;
        }
        if (ctx.dryRun) {
            log.info(`[dry-run] ${entry.original} <- ${entry.backup}`);
            continue;
        }
        fs.mkdirSync(path.dirname(entry.original), { recursive: true });
        fs.copyFileSync(backupPath, entry.original);
        log.ok(`Восстановлен: ${entry.original}`);
    }
    log.ok('Готово. Запустите sync-pulsesync-state.js --force, если восстанавливали app.asar.');
}

// ---------------------------------------------------------------------------
// Синхронизация состояния PulseSync
// ---------------------------------------------------------------------------

function runStateSync() {
    const candidates = [
        path.join(SCRIPT_DIR, 'sync-pulsesync-state.js'),
        path.join(process.cwd(), 'sync-pulsesync-state.js'),
    ];
    const scriptPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!scriptPath) {
        log.warn('sync-pulsesync-state.js не найден. После патча выполните его вручную с --force.');
        return;
    }

    log.info('Синхронизация состояния PulseSync (sync-pulsesync-state.js --force)...');
    const result = spawnSync(process.execPath, [scriptPath, '--force'], {
        stdio: 'inherit',
        cwd: path.dirname(scriptPath),
    });
    if (result.error) {
        log.warn(`Не удалось запустить sync-pulsesync-state.js: ${result.error.message}`);
        return;
    }
    if (result.status !== 0) {
        log.warn(`sync-pulsesync-state.js завершился с кодом ${result.status}. Запустите его вручную.`);
        return;
    }
    log.ok('Состояние PulseSync синхронизировано.');
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
        backupRoot: path.join(SCRIPT_DIR, BACKUP_FOLDER_NAME),
        backupDir: null,
        backupManifest: null,
        asar: null,
        install: null,
        sourceDir: null,
    };

    if (args.restore) {
        restoreLatestBackup(ctx);
        if (!args.noSync) runStateSync();
        return;
    }

    ctx.sourceDir = findSourceDir(args.sourceDir);
    if (!args.installedOnly && !ctx.sourceDir) {
        log.warn('Исходники не найдены; патч исходников пропущен.');
    }

    if (!args.sourceOnly) {
        ctx.install = findInstall(args.installDir);
        assertExeWritable(ctx.install.exe);
        ctx.asar = await loadAsarModule();
        if (!ctx.asar) log.warn('@electron/asar не найден локально. Будет использован npx.');
    }

    log.info(`VibeColorizer Patch v${VERSION}`);
    log.info(`CSS-переменная: ${CSS_VAR}`);
    if (ctx.dryRun) log.info('Режим --dry-run: файлы не изменяются.');

    if (!args.installedOnly) patchSource(ctx);
    if (!args.sourceOnly) await patchInstalled(ctx);

    finalizeBackup(ctx);

    if (!ctx.dryRun && !args.sourceOnly && !args.noSync) runStateSync();

    log.ok('Готово. Запустите Яндекс Музыку заново.');
    log.info('В аддоне VibeColorizer включите нужное количество цветов (1–6).');
}

main().catch((error) => {
    log.err(error?.message || String(error));
    if (process.env.DEBUG && error?.stack) console.error(error.stack);
    process.exitCode = 1;
});
